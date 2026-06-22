# Google sign-in, and the link you must not make

> Increment: `feature/auth` — Google OAuth (arctic) with state + PKCE, and the find-or-create-or-link
> rule behind "Sign in with Google."
> Files: `src/auth/oauth.ts`, `src/auth/google-auth.ts`, `src/auth/routes.ts`, `src/auth/cookies.ts`.

There are three parties in this story, not two.

Mara's browser. Our server. And Google.

Password login was a conversation between two of them — the browser tells our server a secret, our server checks it. Google sign-in is a *flow* between all three, where our server never sees Mara's Google password at all.

The interesting part isn't the flow. arctic handles the steps. The interesting part is the very last decision: Mara shows up with a verified Google email, and there's *already an account here with that email*. Do we merge them?

Get that wrong and you hand one person's account to another.

Let's earn our way to that decision.

---

## The shape of the flow

Everything our server does runs server-side. The browser just carries redirects and cookies between our server and Google.

```
Browser            Our server (/auth)                 Google
  │  GET /google        │                                │
  │  ───────────────►   │  mint state + PKCE verifier     │
  │                     │  stash both in cookies          │
  │  ◄───  302 ─────────│  redirect to Google ──────────► │
  │  ──────────────────────────────────────────────────► │  Mara approves
  │  ◄───  302 back to /google/callback?code=…&state=… ── │
  │  GET /callback      │                                │
  │  ───────────────►   │  check state == cookie          │
  │                     │  exchange code ───────────────► │
  │                     │  ◄─────────── id token ──────── │
  │                     │  find-or-create-or-link         │
  │  ◄───  session ─────│  set cookie, redirect to app    │
  ▼                     ▼                                ▼
```

Two round trips through Google. One `code` that comes back. One identity that falls out of it.

The two cookies we set on the way out — `state` and the PKCE `codeVerifier` — exist only for this flow. They're how the callback proves it's the same browser that started, talking about the same request.

Here's why each one has to be there.

---

## `state`: so the callback can't be forged

Strip out `state` and watch what breaks.

An attacker starts their *own* Google sign-in. Google hands *them* a valid `code`. They don't redeem it. Instead they trick Mara's browser into visiting:

```
/auth/google/callback?code=THE-ATTACKERS-CODE
```

If our server just trusts any `code` that arrives, Mara's browser completes the attacker's login. Mara is now signed in as *the attacker* — and anything she uploads or comments lands in the attacker's account, for them to read.

That's CSRF — **Cross-Site Request Forgery** — and `state` kills it:

    On /google we generate a random state, put it in a cookie, and hand a copy to Google.
    Google echoes it back unchanged on the callback.
    We check: does the state in the URL match the state in the cookie?

The attacker's forged callback carries *their* state, but Mara's browser holds *no* matching cookie — or a different one. Mismatch. Rejected.

```ts
if (query.data.state !== cookieState) {
  throw badRequest('oauth_state_mismatch', 'Google sign-in could not be verified.')
}
```

The state cookie is the thread that ties "who started this" to "who's finishing it."

---

## PKCE: so a stolen `code` is useless

PKCE stands for **Proof Key for Code Exchange** (say it "pixie").

`state` proves the callback came from us. PKCE protects the `code` itself.

The `code` is a one-time ticket Google puts in a redirect URL. Redirect URLs leak — server logs, browser history, a shoulder-surfed address bar. If a leaked `code` were enough to log in, that's a problem.

There are **two different roads to Google**, not one.

    Front channel — through the browser, as redirects. URLs.
                    These leak: server logs, browser history, the address bar.

    Back channel  — a direct server-to-server HTTPS call, our server → Google.
                    The browser never sees it. Nothing here lands in a URL.

PKCE splits one secret across those two roads, so a leak on the front channel buys an attacker nothing. The secret comes in two halves:

    codeVerifier    a long random string — the SECRET. Stays in our httpOnly cookie.
    code_challenge  = SHA-256(codeVerifier) — a one-way hash of it. Safe to make public.

The verifier is the key. The challenge is a photo of the key's *shape* — enough to check a match, not enough to cut a copy.

### Who sends the challenge? The browser does.

`createAuthorizationURL` does **not** talk to Google. It runs locally and does two things:

    1. computes  code_challenge = SHA-256(codeVerifier)
    2. builds a URL to Google's consent screen with that CHALLENGE as a query param

```ts
const url = google.createAuthorizationURL(state, codeVerifier, GOOGLE_SCOPES)
```

That URL carries the **challenge** (the hash) — never the verifier. Then we `reply.redirect(url)`, and the thing that actually *delivers* the challenge to Google is **Mara's browser**, by navigating there. Our server never touches Google's consent endpoint directly. That is the front channel.

Google files the challenge against this request and hands back a one-time `code` — again, through the browser.

### Where arctic talks to Google: the exchange

arctic makes exactly one direct call to Google, and it's in the callback:

```ts
const tokens = await google.validateAuthorizationCode(code, codeVerifier)
```

*This* is the back channel — a server-to-server POST that sends, for the first time, the **verifier** itself. Google computes `SHA-256(verifier)` and checks it equals the challenge it filed earlier. Match → tokens. Mismatch → rejected.

So the two halves reach Google by two different roads:

    challenge (hash)   → the long, leaky way:   our server → browser → Google   (up front)
    verifier  (secret) → the short, private way: our server → Google directly    (only at the end)

The verifier never appears in a single URL. It goes from our cookie straight to Google over TLS, exactly once.

### Why a stolen `code` is dead

Now picture the attacker who scraped the `code` out of a leaked redirect URL. They send it to Google. Google asks: *what's the verifier?*

    They can't read it from a URL — it was never in one.
    They can't read it from the cookie — it's httpOnly, on Mara's machine, not theirs.
    They can't derive it from the challenge — SHA-256 doesn't run backwards.

No verifier, no exchange. The stolen `code` is useless.

A code without its verifier is a key without its cut.

---

## What comes back: an id token, not a password

The exchange returns tokens. The one we care about is the **id token** — a JWT whose payload is a small bag of facts about Mara, signed by Google:

```
{ "sub": "11029...", "email": "mara@work.test", "email_verified": true, "name": "Mara" }
```

`sub` is Google's permanent, unique id for Mara — stable even if she changes her email. That's what we store as her Google identity, not the email.

We got this token directly from Google's token endpoint, over TLS. So we *decode* the claims rather than re-verifying the signature — the secure channel already proved where it came from:

```ts
rawClaims = decodeIdToken(tokens.idToken())
```

Then we parse it strictly. `email_verified` must be a real boolean. If Google ever sent something surprising, the parse fails and the whole sign-in fails — closed, never granting a verification we didn't actually get:

```ts
const googleIdTokenClaims = z.object({
  sub: z.string().min(1),
  email: z.string().email(),
  email_verified: z.boolean().optional(),
  // …
})
```

Fail-closed is the rule whenever the question is "is this email proven?" A wrong "no" is an inconvenience. A wrong "yes" is the bug in the next section.

---

## The decision: create, link, or refuse

Now `signInWithGoogle` has a verified identity in hand. Three cases, in order.

**Case 1 — a returning Google user.** The `sub` already maps to one of our users:

```ts
where(and(eq(accounts.provider, 'google'), eq(accounts.providerUid, claims.googleUserId)))
```

Found it. Open a session. Done. This is the common path.

**Case 3 — a brand-new person.** No Google identity, and no local account owns this email. Create the user and the Google credential together, in one transaction. Google already verified the email, so the new user inherits that.

I'm skipping Case 2 on purpose. Case 2 is the whole reason this doc exists.

---

## Case 2: the email is already taken

Mara signed up weeks ago with an email and password (docs 01–02). Today she clicks "Sign in with Google," and her Google email is the *same address*.

No Google identity yet. But a user row already owns `mara@work.test`.

The tempting move — the one the looser version of this rule actually says — is:

> Google says the email is verified, and it matches. Link them. Log her in.

Here's why that's a door you must not open.

`mara@work.test` being in our `users` table does **not** mean Mara put it there.

Our signup lets anyone type any email. It doesn't prove ownership. So picture this, before Mara ever shows up:

```
1. Attacker signs up with email = mara@work.test, password = (their own).
   Our users table now has a row for mara@work.test. emailVerified = false.
   (It was never proven — nobody clicked a link.)

2. The real Mara later clicks "Sign in with Google."
   Google says: mara@work.test, email_verified = true. It matches!

3. Naive rule auto-links Google to that existing row.
   Mara is now sharing an account with the attacker —
   who still knows the password.
```

The attacker is now inside Mara's account. They planted the email; the verified Google login walked right into the trap.

So matching-and-Google-verified is **not enough**. The fix is to demand proof from **both sides**:

```ts
const bothEmailsVerified = claims.emailVerified && existingUser.emailVerified
if (!bothEmailsVerified) {
  throw conflict('account_exists', 'An account with this email already exists. Sign in with your password to link Google.')
}
```

Google-verified *and* the local account already verified. The attacker's planted row was never verified, so the guard refuses to link and the takeover never happens. We don't merge into an account whose email was never proven — we refuse, and point Mara at the safe path (sign in with your password, then link from settings — that flow is the next increment).

You might assume "verified email matches" is the linking rule. It is half of it. The other half is *whose* verified — and a local row you can't trust doesn't count.

---

## The honest part: Case 2's success path

Case 2's *success* path — actually linking — needs a local account that's already **verified**.

When this rule first landed, nothing could produce that. There was no way to verify a password account, so every "I have a password account, now I'm adding Google" attempt hit the `409 account_exists`. The guard was correct, but in practice refuse-only.

Email verification (the next doc) changed that. A password user confirms their address through the link we email; once verified, a Google sign-in with the same address links cleanly. The guard didn't move — the world caught up to it.

Refusing safely while the verified state was unreachable beat linking unsafely.

---

## When this isn't the right shape

A few limits worth naming.

**This is one provider.** The whole module is Google-shaped — one `sub`, one id token, Google's verified-email semantics. A second provider (GitHub, say) doesn't hand you a reliable `email_verified` at all, and the linking rule would have to change. Don't assume this generalizes for free.

**"Refuse and prompt" needs a real prompt.** Today the refusal is a JSON `409` — fine for a backend, but a browser mid-redirect deserves a page that says "you already have an account, here's how to link." That's frontend work for a later step.

**Decode-don't-verify rests on one assumption:** that the id token came straight from Google's token endpoint over TLS. It does here. If you ever accept an id token from somewhere you didn't fetch it yourself, that shortcut is gone and you must verify the signature.

---

`state` proves the callback is ours.

PKCE proves the code is ours.

And the both-sides-verified guard proves the account is *hers* — before we ever let Google in the door.
