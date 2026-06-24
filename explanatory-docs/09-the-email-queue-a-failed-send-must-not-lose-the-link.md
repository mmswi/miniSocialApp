# The email queue: a failed send must not lose the link

> Increment: `feature/auth` — putting a durable retry queue behind the email seam.
> Files: `src/queue/connection.ts`, `src/queue/email-queue.ts`, `src/queue/email-worker.ts`,
> `src/worker.ts`; integration in `src/auth/verify.ts` and `src/auth/password-auth.ts`; the dev
> co-location in `src/server.ts`. Built on BullMQ + Redis.

Doc 08 ended on a confession.

The send was synchronous, and the fail-soft wrapper "won't *fail* the request, but it can still *slow* it. The real fix is a queue." That was deferred. This is it.

But re-read what fail-soft actually did, because the slowness was the smaller problem:

```ts
const sendSignupEmail = async (send) => {
  try { await send() }
  catch (error) { console.error('email failed to send; signup still succeeds', error) }
}
```

If the mail provider hiccups, we log and move on. Signup still succeeds — good. But the **verification link is now gone.** There was one attempt, it failed, and nothing will ever try again. The user sits at "check your email" forever, staring at an inbox that will never receive anything. The fail-soft wrapper protected the *signup* by sacrificing the *email*.

That trade was right when delivery had no safety net. The job of this increment is to remove the trade.

## Start with what "durable" buys you

The whole idea fits in one swap. Instead of *sending* the email at signup time, *enqueue* it:

```
BEFORE   signup → sendEmail() → SMTP → (provider hiccups) → log + drop. Link lost.

AFTER    signup → enqueueEmail() → Redis. Returns in ~1ms.
                                     ↓
              worker → sendEmail() → SMTP → (hiccups) → BullMQ retries with backoff
                                     ↓ (eventually succeeds)
                                   delivered
```

Two properties fall out:

**Fast.** `enqueueEmail` touches only Redis (local, ~1ms) and returns. Signup no longer waits on a third party at all — not even the instant Mailpit case.

**Durable.** The job lives in Redis. If the first SMTP attempt fails, BullMQ re-runs it later — 5 attempts, exponential backoff. A transient provider outage costs minutes of delay, not a lost account.

## The producer side

`enqueueEmail` is the new seam the app calls. It replaces the direct `sendEmail` at the two template sites in `verify.ts`:

```ts
export const enqueueEmail = async (message) => {
  if (env.NODE_ENV === 'test') {
    await sendEmail(message)   // no worker under test — deliver inline (see below)
    return
  }
  await emailQueue().add(EMAIL_JOB_NAME, message)
}
```

`emailQueue()` is the same singleton pattern as the DB pool and Redis client — one `Queue` per process, cached on `globalThis`, built lazily so the import stays free. The job payload is just the `{ to, subject, text }` from doc 08; the template still decides *what* to say, the queue is purely *how it travels now*.

## The consumer side — and the one bug that matters

The worker drains the queue and delivers each job. The handler is three lines, and one of them is load-bearing:

```ts
export const createEmailJobHandler =
  (deliver) =>
  async (job) => {
    await deliver(job.data)   // throws → BullMQ retries. Do NOT catch here.
  }
```

Here is the trap. Your instinct, fresh off doc 08, is to wrap this in a try/catch — "emails shouldn't crash things." **That instinct breaks the entire feature.**

A BullMQ job is retried *only if it rejects*. If the handler catches the SMTP error and returns normally, BullMQ sees a job that **completed successfully**, drops it, and never retries. You'd have built a queue that swallows failures exactly as silently as the thing it replaced — except now it *looks* robust. The whole point is that `sendEmail` throws (doc 08 kept it honest) and that throw must travel all the way up to BullMQ.

So fail-soft does NOT live in the worker. It moved to wrap only the *enqueue*:

```
producer (signup):   try { await enqueueEmail(...) } catch { log }   ← guards a rare Redis hiccup
worker (delivery):   await deliver(job.data)                          ← MUST reject so BullMQ retries
```

The producer still can't fail signup or reopen the doc-06 enumeration oracle — but now it's guarding a local Redis write (almost never fails), not a flaky third-party SMTP call. The flaky part got moved to where retries live.

This is also the one thing worth a unit test, and it's the cheapest test in the suite:

```ts
const handle = createEmailJobHandler(async () => { throw new Error('smtp down') })
await expect(handle({ data: message })).rejects.toThrow('smtp down')   // proves: rejects → will retry
```

Delivery is *injected* into the handler precisely so this test can drive a failure without a real mail server. We don't test BullMQ's backoff — that's the library's job. We test our wiring: a failed delivery rejects.

## Test mode still has no worker

Under `bun test` there's no worker process running, so a queued job would sit in Redis forever and the auth E2E — which reads the verification link back out of the in-memory `sentEmails` array (doc 08) — would hang.

So `enqueueEmail` keeps the same `NODE_ENV` fork as `sendEmail`: under test it delivers **inline**, straight to `sentEmails`. The queue is real in dev and prod; in test it's transparent. The E2E test never knew the queue arrived.

## Two ways to run the worker

In production the worker is its **own process** — a separate container from the API. That's the entire point of CLAUDE.md's "persistent ws + worker, NOT serverless": a slow mail provider ties up a *worker*, never an API request handler.

```
bun run src/worker.ts        # prod: the standalone consumer
```

But forcing two terminals in dev would silently break the signup→Mailpit flow the moment you forget the second one. So in development the API boots the same worker **in-process**:

```ts
// server.ts, after listen()
if (env.NODE_ENV === 'development') {
  createEmailWorker()   // one `bun run api` still delivers email end to end
}
```

Same worker module either way. Dev co-locates for convenience; prod splits for isolation. The split is config-shaped, not a code fork.

## Pass connection config, not a client

BullMQ's `connection` accepts either a live ioredis instance or a plain options object. Hand it an object:

```ts
new Queue(EMAIL_QUEUE_NAME, { connection: queueConnectionConfig() })  // { host, port, maxRetriesPerRequest: null, … }
```

…and BullMQ builds and **owns** its own connections from it. Two payoffs.

First, a blocking worker needs its *own* connection — a `BRPOPLPUSH` that waits indefinitely for the next job would stall anything sharing the socket — so letting BullMQ create them means you never accidentally share one.

Second, and subtler: BullMQ bundles its *own* copy of ioredis, often a different version than the app's. A `Redis` *instance* from one copy is a different class than the other's, so passing your app's client across that line is a type error (and an `instanceof` hazard at runtime). A plain options object has no class identity — it crosses cleanly, and the two ioredis copies never have to be reconciled.

The one option that matters is `maxRetriesPerRequest: null`, and it lives *only* on BullMQ's connections. The app's shared client keeps ioredis's default, so an ordinary cache GET fails fast instead of hanging forever waiting on a dead Redis.

BullMQ itself is the deliberate choice here, same reasoning as `argon2id` and `arctic` in doc 02 — a reliable queue (atomic claim, visibility timeout, backoff, dead-lettering) is genuinely hard to get right, so you stand on a vetted primitive rather than hand-roll the core.

## The five questions

    Where does each step run?  enqueue: the API process. delivery: the worker process (prod) or the
                               API process (dev). Mailpit/provider: external.
    What shape is the data?    { to, subject, text } → a BullMQ job in Redis → SMTP wire bytes. Same
                               payload as doc 08; it just rides through Redis on the way now.
    What gets stored?          The job, transiently in Redis: dropped on success, KEPT on permanent
                               failure (removeOnFail: false) so a dead letter is inspectable.
    What's computed fresh?     Nothing new — the subject/body/link are still built by the template
                               before enqueue (doc 08). The worker only transports.
    What's handed onward?      producer → Redis → worker → the SMTP socket.

## When this is the wrong shape

**The commit-and-enqueue gap.** Signup commits the user row, then enqueues. If the process dies in the microsecond between, the row exists and no email job does — the same lost-link symptom, just far rarer. Closing it needs a *transactional outbox* (write the job to Postgres in the same transaction as the user, a relay moves it to Redis). That's the next tier of durability and deliberately not built here — the failure window went from "any SMTP hiccup" to "a crash in a one-instruction window," which is the right amount of hardening for this slice.

**The raw token rides in the job.** Only the token's *hash* is in the DB (doc 04), but the queued job carries the raw token in its payload, briefly, in Redis. Acceptable — Redis is trusted infra and the job is dropped on delivery — but it's a wider blast radius than the DB, worth a note for a stricter threat model.

Doc 08 gave the email one honest attempt.
This gives it as many as it takes — and refuses to call a swallowed failure a success.
