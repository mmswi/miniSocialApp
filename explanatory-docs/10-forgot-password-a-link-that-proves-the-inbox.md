# Forgot password: a link that proves the inbox

> Increment: `feature/auth` — self-service password reset (not in the original plan; added after the
> email queue). Files: `src/auth/password-reset.ts`, `src/db/schema.ts` (`password_reset_tokens`),
> routes + rate limits in `src/auth/routes.ts` / `ratelimit.ts`, and the web pages
> `ForgotPasswordPage` / `ResetPasswordPage`.

A password reset looks like a new feature. It's really one you already built, pointed in a new direction.

Email verification (doc 04) proved a claim: *you control this inbox.* It did that with a single-use, hashed, expiring token mailed as a link. Forgot-password uses the **exact same mechanism** — and then spends that proof differently. Verification flips an `email_verified` flag. Reset lets you **replace the password**. Same proof of inbox control; a much bigger payoff. That's the whole idea, and also the whole danger: a reset link is a bearer credential that can take over an account, so every property below exists to keep it narrow.

## Two steps, two endpoints

```
/forgot-password (email)
   → POST /auth/forgot-password   → always 200; IF a password account exists, issue token + email link
   → link: ${APP_URL}/reset-password?token=…   (the FRONTEND, not the API — it has a form to show)
/reset-password (new password)
   → POST /auth/reset-password    → consume token, set hash, revoke ALL sessions
   → /login?reset=1
```

One asymmetry worth noticing: the verification link hits `GET /auth/verify` **on the API** directly, because it has nothing to collect — click and you're done. The reset link points at a **frontend page**, because the user still has to type the new password. The token rides the URL to the browser; the browser POSTs it back with the password.

## No enumeration — the same answer either way

`/forgot-password` returns a byte-identical `200 { message: "If that email has an account, we sent a password reset link." }` whether or not that email exists. This is the doc-06 stance again: the endpoint must not become an oracle that confirms which emails are registered. The service only *acts* (issues a token, sends mail) when a password account exists; otherwise it silently does nothing. The differentiating signal — an email, or no email — lands in an inbox only the owner reads.

The honest caveat: the real path does an extra token-insert + enqueue (~a few ms) that the unknown path skips, so there's a residual *timing* difference. It's far weaker than login's ~50ms argon2 gap (which we equalize with a decoy hash), and faking a row-insert to hide it isn't worth it at this tier — so it's accepted and documented, not hidden.

## The token: same shape as verification, tighter dial

Reuses `generateToken` (256 bits) + `hashToken` (sha256) — only the **hash** is stored, so a DB leak yields no usable link. Single-use: consumed (deleted) on success, and a used token reads identically to one that never existed. Two dials turned tighter than verification, because a reset is higher-risk:

- **1 hour TTL**, not 24. A reset link is more dangerous to leave lying around.
- **Issuing a new link invalidates the old one** — `createPasswordResetToken` deletes any prior token for that user first, so only the most recent link works. Request three, only the third resolves.

## The reset is one transaction — all of it, or none

Verification flipped one flag and deleted one token in a transaction. Reset has *more* moving parts, and they must move together:

```ts
await db.transaction(async (tx) => {
  await tx.update(accounts).set({ passwordHash }).where(/* this user's password account */)
  await tx.update(users).set({ emailVerified: true }).where(/* this user */)
  await tx.delete(passwordResetTokens).where(/* this token */)
  await tx.delete(sessions).where(/* every session for this user */)
})
```

Why atomic: a crash between "set new hash" and "consume token" would leave a **reusable link** for an already-changed password; a crash the other way would **spend the token without changing the password** — locking the user out with no working link. One transaction makes it all-or-nothing. (The argon2 hash is computed *before* the transaction, so the slow part doesn't hold row locks; the token is still unconsumed at that point, so a crash there just leaves a valid unused link — the safe failure.)

Two of those four statements deserve their own note:

- **`emailVerified: true`** — clicking the reset link *is* proof of inbox control, the same proof verification asks for. So a reset doubles as a verification; no reason to leave the email unverified afterward.
- **delete every session** — a reset is the "I think I'm compromised" button. Revoking all sessions logs out anyone holding a stolen cookie. *Caveat:* the session cache (doc on sessions) has a 60s read-through TTL, so a cached session can outlive the reset by up to a minute — we delete the Postgres rows instantly but don't hunt down per-user cache keys. Accepted, and called out rather than discovered later.

## Scope: password accounts only

A Google-only account has no password to reset. Forgot-password deliberately does **nothing** for it (and, thanks to the uniform response, doesn't reveal that). Letting this flow *set* a first password on a Google account is a real feature — "set-password / reverse link" — but it's a different door with its own threat model, kept separate on purpose. Forgot-password resets an existing password; it doesn't mint one.

## One more email: the alarm

After a successful reset we queue a *"your password was changed"* notice to the owner (best-effort, riding the doc-09 queue). If an attacker who breached the inbox resets the password, this is the message that tells the real owner something happened. It's cheap and it's the difference between a silent takeover and a noticed one.

## The five questions

    Where does each step run?   forgot + reset: the API. The link round-trips through the user's
                                inbox (external) and the frontend reset page (client). Sends go through
                                the queue → worker (doc 09).
    What shape is the data?     email → reset token (hash stored, raw mailed) → { token, newPassword }
                                → a new argon2 hash on the account.
    What gets stored?           Only the token's hash, transiently (deleted on use/expiry). The new
                                password hash replaces the old. Nothing about the email persists.
    What's computed fresh?      The token per request; the argon2 hash per reset.
    What's handed onward?       email → token-in-link → token+password back → hash. Sessions are
                                deleted, not handed on.

## When this is the wrong shape

**The commit-and-enqueue gap, again.** `requestPasswordReset` writes the token row, then enqueues the email best-effort. If the enqueue is dropped (it's fail-soft, so the endpoint still returns a uniform 200), the user sees "check your email" but no mail arrives — they just request another link. Tolerable here precisely because retrying is free and the uniform response can't be allowed to break.

**Rate limiting is per-IP, not per-account.** `forgotPassword` is capped per IP (like signup), which blunts mass probing and mail-bombing — but a distributed attacker could still trigger many reset emails to one victim from many IPs. The token is harmless without the inbox, so this is annoyance, not compromise; a per-account send throttle is the next dial if it matters.

Verification asked the inbox to prove a claim.
Reset asks the same proof — and then lets it rewrite the password, once, atomically, and tells you it happened.
