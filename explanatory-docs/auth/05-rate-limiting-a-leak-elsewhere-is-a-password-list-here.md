# Rate limiting: a leak somewhere else is a password list for here

> Increment: `feature/auth` — per-IP rate limits on the auth endpoints, backed by Redis.
> Files: `src/auth/ratelimit.ts`, `src/server.ts`, and the `config.rateLimit` on each auth route.

Attackers rarely guess one password ten thousand times.

They take ten thousand email/password pairs leaked from *some other* site and try each one once against your login. People reuse passwords, so a small fraction work. This is **credential stuffing**, and a login endpoint that answers as fast as you can ask is its ideal target.

The defense isn't a better password check. It's a budget: a client gets N tries per minute, then the door stops opening.

## What we count, and where

One counter, per client IP, per endpoint, per time window.

    key:    rate-limit for POST /auth/login from 203.0.113.7
    value:  a number, starting at 0
    expiry: 1 minute

Every request to that endpoint from that IP does two things in Redis:

    INCR the counter
    set EXPIRE to the window, on the first hit

When the counter passes the limit, the next request gets a `429 Too Many Requests` before it ever reaches the handler. A minute later the key expires, the counter is gone, and the budget resets.

The limits, tuned to how often a real person does each thing:

    signup            5  / minute
    login            10  / minute
    verify           10  / minute
    google (+ cb)    10  / minute

## Why the counter lives in Redis, not memory

The app will be deployed with two app instances behind a load balancer.

If each instance kept its counts in its own memory, an attacker capped at 10/min on instance A would get a *fresh* 10/min the moment the balancer sent them to instance B — 20/min across two, 30 across three. The limit would dissolve the more you scaled.

So the counter lives in **one shared Redis**. Both instances `INCR` the same key, so the attacker's 11th request is the 11th no matter which instance handles it. It's the same shared-Redis property that makes sessions work across instances (doc 01): one source of truth, many readers.

## What we don't limit

`global: false` means the limiter touches only routes that opt in:

```ts
app.post('/login', { config: { rateLimit: AUTH_RATE_LIMITS.login } }, handler)
```

`/health` and `/ready` are left out deliberately. The load balancer hits them every few seconds to decide whether to route traffic; throttling them would make the platform think the app is down and pull it from rotation. The limiter guards the doors attackers push on, not the ones the infrastructure knocks on.

## What is `req.ip` and where does it come from?

The whole limiter rests on one value.

`req.ip`. The counter keys on it. Every request that shares a `req.ip` shares a bucket.

So per-IP limiting is only as correct as `req.ip` being *the real client*. Get that wrong and the limiter doesn't bend — it breaks, in one of two opposite directions.

Here is the break. In production the request never reaches you directly:

```
client ──TCP──> load balancer ──new TCP──> your instance
```

The balancer doesn't pass the client's connection through. It opens its *own* connection to your instance. So the socket your process sees belongs to the *balancer*, not the client.

If `req.ip` were the raw socket address, then in prod every request — from every user on earth — would arrive wearing the same IP:

    req.ip = the balancer, for everyone

Now the counter does the opposite of its job. `signup` at 5/min is no longer 5 per user — it's 5 *total*, shared by the whole internet. The sixth signup anywhere trips it. The limiter has become a self-inflicted outage.

So how does the real client IP survive the hop? The balancer writes it into a header:

    X-Forwarded-For: <original client>, <next hop>, ...

Leftmost is the original client. Each proxy *appends* the address that connected to it. The rightmost entry is the freshest — stamped by the proxy nearest you.

`trustProxy` is the switch that decides which value Fastify reads into `req.ip`:

- `trustProxy: false` → `req.ip` is the raw socket address. Whoever physically connected.
- `trustProxy: <trusted proxies>` → `req.ip` is taken from `X-Forwarded-For` instead — but only across the proxies you declare trustworthy.

It adds no security by itself. It only tells Fastify *which value to believe*.

### Locally, trust nothing

On your machine nothing sits in front of the app. The browser connects straight to it.

```
your browser ──TCP──> Fastify
```

The socket address already *is* the real client. So the correct config is to trust no proxy at all.

That's why `TRUST_PROXY` is empty in `.env`. `env.ts:10` defaults it to `''`, and `server.ts:26` turns empty into `false`:

```ts
trustProxy: env.TRUST_PROXY === '' ? false : env.TRUST_PROXY,
```

Empty is not a missing value. It is the right value for an environment with no proxy. Setting it locally would be the bug.

### Is the balancer always the same address? No.

This is the part that trips people up. On a managed host — Railway, Render, Fly — there is no single balancer IP to point at.

The balancer is a *fleet*. A pool of edge proxies the platform runs. They scale up and down. Their addresses rotate. You are never handed the list.

So "set `trustProxy` to the balancer's address" is a trap on these hosts. Pin one IP and it works — until the platform adds a node next Tuesday whose address you never pinned, and `req.ip` goes quietly wrong.

The way out is to stop naming addresses and start describing *trust*. To do that, look closely at what a request actually carries when it lands on your instance.

### How the header gets built — a chain of custody

Two pieces of "who sent this" arrive together, and they disagree.

One is the **socket address** — the IP at the far end of the real TCP connection into your process. The OS reports it and nobody can forge it, because you can't finish a TCP handshake while pretending to hold an IP you don't. But behind a balancer it's *the balancer's* address: true, identical on every request, useless for telling clients apart.

The other is the **`X-Forwarded-For` header** — text that names the actual client. The right machine, but only as trustworthy as whoever wrote the text.

So `trustProxy`'s real job is to turn the header (right machine, possibly lying) into `req.ip` safely, using the socket address (honest, but the balancer) as its anchor. To see how, you need the rule every proxy obeys when it builds that header:

> Forwarding a request, a proxy appends the address it received the request *from* — the socket address it saw — onto the end of `X-Forwarded-For`.

Watch it fill in. One client, one balancer:

```
client 9.9.9.9  ──TCP──>  balancer  ──TCP──>  your app

at the balancer:  its socket peer is 9.9.9.9    →  appends   X-Forwarded-For: 9.9.9.9
at your app:      its socket peer is the balancer;  header reads   X-Forwarded-For: 9.9.9.9
```

The balancer could not put the client into the *source IP* of its own connection to you — that slot is forced to be the balancer's address. So it wrote the client where it could: an appended header entry.

Now Fastify reassembles the route. Socket address first (the machine nearest you), then the header entries read right-to-left, because the *rightmost* was appended by the proxy *closest* to you:

```
[ balancer,     9.9.9.9 ]
  index 0        index 1
  nearest you    the client
```

Index 0 is who connected to you. Index 1 is who connected to *them*. The list is the request's path, retraced from your door outward.

### First, what a "hop" is

A hop is one handoff — one machine passing the request straight to the next.

The word is borrowed from networking. A packet crosses the internet by *hopping* from router to router until it arrives; `traceroute` prints those hops as a numbered list. Same idea one level up: each machine the request passes *through* on its way to you is a hop.

The path from a moment ago has two of them:

```
client  ──hop──>  balancer  ──hop──>  your app
```

The machine in the middle — the one the request passes *through* — is a proxy. So a "hop," here, is one proxy standing between you and the client.

Don't count the two arrows and say "two." `trustProxy` cares about the proxies *between* you and the client, and in this path there's exactly one: the balancer. How many of those you trust is the count the next section is about.

### "Counting hops" is choosing how far down that list to walk

Now the count means something exact.

Index 0 you observed yourself — trustworthy. Index 1 was written by index 0, the balancer, which you own — trustworthy. The real client is the first entry written by a machine you do *not* control.

`trustProxy: <n>` says: "the `n` hops nearest me are my proxies; trust their appends. `req.ip` is the entry just past them." Your installed Fastify (`node_modules/fastify/lib/request.js:48`):

```js
if (typeof tp === 'number') {
  // Support trusting hop count
  return function (a, i) { return i < tp }
}
```

`i < tp` reads "index `i` is one of my trusted proxies if it's among the first `tp`." With `tp = 1`: index 0 is trusted, so walk past it; index 1 is not, so stop. `req.ip` = index 1.

So how do you actually get `n`? Reason it from your architecture, then confirm it by measuring.

**Reason it.** `n` isn't discovered — it's how many forwarding proxies *you* put between the internet and your app, and you built the deployment:

- A bare managed host (Railway, Render, Fly) puts **one** proxy in front of your container — its edge load balancer. `n = 1`.
- Add a CDN (Cloudflare) in front of that → **2**: CDN, then platform edge.
- Every forwarding layer you stack is `+1`. That's the whole rule.

The **two app instances are not hops.** The balancer routes each request to *one* of them, and that instance sees exactly one proxy in front of it — the balancer. Two instances is horizontal scale, not two hops in a chain. So for this app, `n = 1`.

**Then confirm it — never ship a guessed `n`.** From a device whose public IP you know (search "what is my IP" → say `203.0.113.7`), hit any endpoint while logging two raw values in the handler:

```ts
req.socket.remoteAddress        // the socket peer — who connected to you
req.headers['x-forwarded-for']  // the appended chain, as text
```

Lay them out nearest-first — `[ socket, ...x-forwarded-for reversed ]` — and find your known IP. Its index *is* `n`:

```
socket: <edge>   x-forwarded-for: 203.0.113.7
list:   [ <edge>, 203.0.113.7 ]
          index 0    index 1     ← your IP sits here → n = 1
```

Measure because only *exactly* `n` is correct:

- **Too low** → you stop on a proxy, and every client behind it shares one `req.ip` — the whole-internet-in-one-bucket outage again.
- **Too high** → an attacker adds one `X-Forwarded-For` entry past the real client and you read *that* — the `true` spoofing hole, one step early.

Reasoning gives you the number; one logged request proves it.

### Why the count can't be tricked

The attacker *is* the client, and wants a fresh IP every request. So they put a lie in the header they send:

```
attacker, real IP 9.9.9.9, sends:   X-Forwarded-For: 1.2.3.4   (a lie)
```

But the balancer obeys the rule — it appends *what it saw*, the attacker's real socket peer `9.9.9.9`, to the right of the lie:

```
X-Forwarded-For: 1.2.3.4, 9.9.9.9
                 │         └─ the balancer's truthful append
                 └─ the attacker's free text
```

Fastify's list, nearest-first:

```
[ balancer,     9.9.9.9,   1.2.3.4 ]
  index 0        index 1     index 2
  yours          real IP     the lie
```

`trustProxy: 1` stops at index 1 = **9.9.9.9**, the attacker's real address. The forged `1.2.3.4` sits at index 2 — past the trust boundary, never read.

That's the crux. A proxy you trust always writes the truth to the *right* of whatever the client wrote. You count in from the right. So the walk crosses only truthful appends and halts before it reaches the client's free text. The attacker can scribble anything on the left; you never read the left.

Which is why you never needed the balancer's address — only the count: how many of your own proxies stand in front. Identity by *position in the chain*, not by IP.

### Pick one value — these are alternatives, not steps

`TRUST_PROXY` is one variable that holds one value. Counting, a range, the default — these are **not** stages you stack. They are different values you could give that one variable, and you choose **exactly one**:

- **`TRUST_PROXY=1` — a count.** "1 proxy stands in front of me." No IP, no lookup; it survives the balancer's address changing. **For this app, this is the value.**
- **`TRUST_PROXY=10.0.0.0/8` — a range.** "Trust any sender inside this block." `10.0.0.0/8` is a CIDR — Classless Inter-Domain Routing — every address from `10.0.0.0` to `10.255.255.255`, wide enough that a rotating proxy IP always lands inside it. Use this *only* when you can't rely on a fixed proxy count but the platform documents the block its proxies live in. Not your case.
- **`TRUST_PROXY=` (empty → `false`) — trust nothing.** `req.ip` is the raw socket address. Correct locally, where no proxy sits in front of you.

So the decision for this deploy is one line: **`TRUST_PROXY=1`.** Not `1` *and* a range. Just `1`.

(Not a `TRUST_PROXY` value at all: some platforms stamp a header they overwrite on every request — Fly's `Fly-Client-IP`, Cloudflare's `CF-Connecting-IP` — which you'd read with a custom `keyGenerator` instead of `trustProxy`. Ignore it unless you deploy on one of those.)

### The trap: `trustProxy: true`

In the counting model, `true` has an exact meaning: *trust unlimited hops.* Walk the list all the way to the end.

The end of the list is the leftmost `X-Forwarded-For` entry — the one the original client wrote, the one farthest from any proxy's truthful append. The attacker owns precisely that entry:

```
attacker sends a fresh lie each request:
  X-Forwarded-For: 1.2.3.4   →  req.ip = 1.2.3.4
  X-Forwarded-For: 1.2.3.5   →  req.ip = 1.2.3.5
  X-Forwarded-For: 1.2.3.6   →  req.ip = 1.2.3.6
```

Every request a new IP, every IP a fresh bucket, the counter never reaching the 11th. The limiter is present, configured-looking, and doing nothing — worse than absent.

So both failures are the same mistake at opposite extremes: *where you stop counting.* Stop at zero (`false`, behind a balancer) and every request collapses onto the balancer's single IP — one shared bucket, the whole internet throttled together. Walk to the end (`true`) and you land on attacker-controlled text — no throttle at all. The safe stop is the exact number of proxies you own: not zero, not infinity. For this app, `1`.


### One gap in the current wiring

The portable form — counting — does not actually work in this code yet.

`getTrustProxyFn` branches on the *type* of the value (`request.js:48-55`): a **number** is a hop count, a **string** is a list of subnets. But `env.TRUST_PROXY` is *always* a string — `env.ts:10` is `z.string()` — and `server.ts:26` passes it through untouched:

- `TRUST_PROXY=10.0.0.0/8` → string → read as a subnet → the range form works.
- `TRUST_PROXY=1` → the string `"1"` → Fastify tries to read `"1"` as a *subnet*, not a hop count → the count silently breaks.

So today the range form works and the count form does not. Closing it is a one-line coercion — if `TRUST_PROXY` is all digits, pass `Number(...)` so it reaches the number branch — left as a follow-up.

The real-IP rule, in three beats:

    The socket address is honest but it names the balancer; the header names the client but anyone can forge it.
    So you trust your own proxies by counting in from your door — one hop for one balancer — and take the IP just past them.
    Count too few and you throttle everyone; count too many and you throttle no one; count exactly your proxies and req.ip is the real client.

## The gotcha: a custom error handler eats the 429

The plugin doesn't `reply.send` the 429 — it **throws** it:

```js
throw params.errorResponseBuilder(req, respCtx)   // inside @fastify/rate-limit
```

Whatever `errorResponseBuilder` returns gets thrown, and a thrown value lands in the app's error handler. Ours (doc 02) only recognizes `AppError`; everything else it treats as an unexpected bug and turns into a `500`. So the first version, which returned a plain `{ error, message }` object, made every rate-limited request come back `500` instead of `429`. The limiter was working — the `x-ratelimit-remaining` header counted down to 0 — but the response was wrong.

The fix is to throw something the handler already understands: an `AppError` with status 429.

```ts
errorResponseBuilder: (_req, context) =>
  new AppError('rate_limited', `Too many requests. Try again in ${seconds}s.`, 429)
```

The plugin throws that `AppError`, the handler renders it as a clean `429 { error: 'rate_limited', … }`, and the `Retry-After` header the plugin already set on the reply rides along. The lesson generalizes: a custom error handler owns *every* error in the app, including the ones plugins throw.

## When this is the wrong shape — two real limits

The real-IP requirement above is a configuration you can get right. These two you can't — they're inherent to throttling by IP.

**Fail-open on a Redis outage.** `skipOnError: true` means that if Redis is unreachable, the limiter lets the request through instead of blocking it. That's a deliberate trade: rate limiting is defense-in-depth, not the front door, so a Redis blip shouldn't lock every user out of login. The cost is that during a Redis outage there's no throttling at all. Availability over security, chosen on purpose.

**Per-IP doesn't stop a botnet on one account.** This limits requests *per source IP*. An attacker spread across a thousand IPs, each making a few attempts at one victim's account, stays under every per-IP limit. Defending a single targeted account needs a *per-account* limit — attempts per email, regardless of source — a different counter for a different threat. Credential stuffing (many accounts, one source) is what per-IP stops, and what this increment scopes; the per-account layer is future work.

---

Count the attempts, not the passwords.

Share the count, so scaling out doesn't dissolve it.

Fail open, so the guard never becomes the outage.
