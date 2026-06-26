# Email verification: a claim is not a proof

> Increment: `feature/auth` — issuing, sending, and consuming a single-use email-verification token.
> Files: `src/auth/verify.ts`, `src/lib/email.ts`, `src/auth/routes.ts`, and the `users.emailVerified` flag.

Signup asked Mara for an email. It never asked the email whether it wanted Mara.

Anyone can type anyone's address into a signup form. A row in our `users` table that reads `mara@work.test` is a *claim* — "someone said they own this" — not a *proof*. Doc 03 showed the damage when you treat the claim as proof: an attacker registers a victim's address, and a later real Google login links straight into the attacker's account.

Verification turns the claim into a proof. The mechanism is one link, clicked once.

## What "verified" has to mean

`users.emailVerified` is a single boolean. The job of this whole increment is to make sure it only ever flips to `true` for someone who can actually read mail at that address.

So we send something to the address and check whether it comes back. That something is a token.

## The token is a session token in a different hat

We already built this shape for sessions (doc 01). The moves are identical:

    generate a long random token   — 32 bytes, unguessable
    store only its sha256 hash     — the id column of email_verification_tokens
    put the RAW token in the link  — the only copy that leaves the server
    give it an expiry              — 24 hours

```ts
const rawToken = generateToken()
await db.insert(emailVerificationTokens).values({ id: hashToken(rawToken), userId, expiresAt })
```

The raw token rides in the email. The database keeps only `sha256(rawToken)`. A leak of that table hands an attacker a column of hashes that open nothing — the same reason session tokens are stored hashed.

The bad version makes the point: email a link like `?verify=user_42`. Now anyone verifies anyone by editing the URL. The token is long and random *because* it has to be the proof — unguessable and unforgeable, not just an id.

## The flow

    Signup                                                          (server)
    ↓
    issue token: store sha256(token), email the raw token in a link (server)
    ↓
    Mara opens her inbox and clicks the link                        (client)
    ↓
    GET /auth/verify?token=…                                        (server)
    ↓
    sha256 the token, look it up, check expiry
    ↓
    flip emailVerified = true, delete the token, redirect to the app

Server-side at every step except the click. The only thing stored is the hash, plus the flag once it flips. What's recomputed on the click is the `sha256` and the lookup. What's single-use is the token row — deleted the instant it succeeds.

## Single-use, and why the row is deleted

```ts
await db.transaction(async (tx) => {
  await tx.update(users).set({ emailVerified: true }).where(eq(users.id, row.userId))
  await tx.delete(emailVerificationTokens).where(eq(emailVerificationTokens.id, id))
})
```

The flip and the delete commit together. A token that already verified someone no longer exists, so the same link can't be replayed into a second verification.

That deletion shapes the error messages.

## Two answers, never three

A verify fails in two ways the user can tell apart:

    expired   — the link is older than 24 hours
    invalid   — unknown, or already used

It cannot separate "already used" from "never existed" — a used token was *deleted*, so there's no row left to distinguish it. Both return `invalid_verification_token`. Keeping a tombstone that said "this one was used" would be an oracle: a way to probe which tokens once existed. Forgetting is safer.

One rule holds on every branch: a bad token is a clean `400`, never a `500`. Expired, empty, unknown, array-valued, already-used — each is a handled answer with its own code.

## What this unlocks

The flag isn't decoration.

- **The Google auto-link from doc 03 becomes reachable.** A verified password account can now merge with a matching verified Google login — the exact precondition the takeover guard was waiting on.
- **A uniform signup response becomes possible.** Signup can eventually answer "check your email" identically whether the address is new or already registered, moving the real signal into the inbox instead of the HTTP status. (That's a later increment; today a duplicate signup still returns `409`.)

## When this is the wrong shape

**A GET that changes state will be clicked by robots.** The verify link is a plain URL in an email, so the browser fetches it with a GET — and so does every link scanner that touches the message first: corporate mail filters, antivirus, chat-app link previews. That bot's GET hits `/auth/verify`, flips the flag, and *deletes the token* before Mara clicks. She ends up verified, but her real click then shows "invalid or already used." It's confusing, not a hole — the scanner can only verify the address it was already trusted to handle. The standard fix is a two-step page: the GET renders a "Confirm" button and a POST does the mutation, which scanners don't follow. That's frontend work for later, and the wart is inherent to a link that both arrives by GET and changes state.

**The mail transport is a stub.** `sendEmail` logs the link to the console in dev and records it in memory under test. A real provider — and a queue, so a slow send can't stall a signup — gets wired in behind that same function later.

**Unverified users can still log in.** We don't gate basic access on verification; an unverified Mara can sign in and look around. Verification gates *linking*, not the front door. That's a policy choice — an app moving money would gate more.

---

A token sent is a question: can you read this?

A token returned is the answer: yes.

The flag it flips is the difference between a claim and a proof.
