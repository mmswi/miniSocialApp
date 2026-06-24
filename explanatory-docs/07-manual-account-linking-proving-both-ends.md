# Manual account linking: when you've already proven both ends

> Increment: `feature/auth` — A6, the manual half of account linking.
> Files: `src/auth/linking.ts`, `src/auth/routes.ts` (`/auth/google/link` + the callback branch),
> `src/auth/cookies.ts`. Builds on doc 03 (the auto-link and the takeover guard).

Mara signed up with a password: `mara@redline.com`.

Now she wants to *also* sign in with Google — but her Google address is `mara@gmail.com`. A different email.

She has two ways to prove she's Mara. The system sees two strangers.

Linking is making them one user: two `accounts` rows — one `password`, one `google` — pointing at one `users` row.

Doc 03 built *one* way to link, and it can't help her here.

## Why the auto-link can't do this

Doc 03's rule: when a Google sign-in arrives, auto-link it to an existing local account **only if the Google email is verified and matches**. Otherwise refuse — "sign in with your password to link Google."

Run Mara through it:

```
Google says: mara@gmail.com
Local has:   mara@redline.com
```

The emails don't match. The auto-link looks for a local user with `mara@gmail.com`, finds none, and does the only safe thing it can for an anonymous caller: it creates a *brand-new, separate* account for `mara@gmail.com`.

Now Mara has two accounts and no way to merge them.

That's not a bug in the auto-link. It's the auto-link being careful. Watch *why*.

## The asymmetry — this is the whole idea

The auto-link runs for an **anonymous** caller. Someone just showed up with a Google login. The server cannot tell Mara from an attacker who registered `mara@redline.com` first. So it trusts almost nothing: it links only when both sides carry a verified, matching email — proof that can't be faked by typing an address.

Manual linking runs for a caller who has **already proven both ends**:

```
a valid session   → they own mara@redline.com   (they're logged in)
a finished OAuth   → they control mara@gmail.com (Google just confirmed it)
```

Both halves are proven *before* `linkGoogleAccount` is even called. So it requires **no email match at all**. That's not a relaxed-security shortcut — it's the entire reason manual linking exists. The case the auto-link refuses (different email, or unverified) is exactly the case only a signed-in user should be allowed to resolve, by hand.

> Anonymous caller → trust almost nothing → match verified emails.
> Authenticated caller who finished OAuth → both ends already proven → no match needed.

## The flow

Mara is signed in. She clicks "Connect Google."

```
GET /auth/google/link        (server: she has a session? if not → 401)
↓
mint state + PKCE, set handshake cookies   ← same as doc 03
set the link marker cookie                 ← the one new thing
↓
redirect to Google's consent screen        (client → google.com)
↓
Google redirects back: GET /auth/google/callback?code=…&state=…
↓
verify state (CSRF), exchange code for claims   ← same as doc 03
↓
marker present? ── yes ──► re-check session ─► linkGoogleAccount(userId, claims) ─► redirect ?linked=google
              └─ no  ──► sign in (doc 03's path)
```

Google only lets us register **one** callback URL, so sign-in and link come back to the *same* `/auth/google/callback`. The callback has to know which one it is. That's what the marker cookie is for: `/auth/google/link` sets it; the callback reads it to pick the branch.

Notice the **re-check session** step. The marker only says "this was a link attempt." It does not say *who*. The session cookie says who — and it might have expired while Mara was on Google's consent screen. So the callback reads the session again, right then, and links to whoever is actually still signed in. The marker is a mode flag, never a trust token.

## The trap: a stale marker

Here's a bug that hides in the one path no test can reach (the callback needs a live Google to exercise).

`state` and `verifier` are written by *both* start routes, so they're always fresh. If the marker were written by *only* `/auth/google/link`, it could go stale:

```
Mara clicks "Connect Google"   → marker set (lives 10 min)
Mara abandons it at Google
Mara clicks "Sign in with Google" → /auth/google sets new state + verifier…
                                     …but the old marker is still in the jar
↓
callback sees the marker → treats a plain sign-in as a link → mislink or a spurious 401
```

The fix is to make **both** start routes write a *definitive* mode. `/auth/google/link` sets the marker; `/auth/google` **clears** it. Now there's exactly one source of truth per flow, and the callback can never read a marker left over from a flow that was abandoned.

```ts
// /auth/google (sign-in)         → clearOAuthLinkCookie(reply)
// /auth/google/link (linking)    → setOAuthLinkCookie(reply)
```

Because no test covers that branch, it has to be correct *by construction*. Two routes, two definitive writes, no leftover state.

## What linkGoogleAccount refuses

No email match — but not *no* rules. A Google identity belongs to exactly one user, and that's enforced:

```ts
// already linked to THIS user      → idempotent no-op (a double-click is success, not an error)
// already linked to ANOTHER user   → 409: you haven't proven you own that one
// this user already has a Google   → 409: one Google identity per account
// otherwise                        → insert; UNIQUE(provider, provider_uid) is the atomic backstop
```

The takeover-critical guarantee is that last index: even if two requests race past the in-code checks, the database lets exactly one `(google, sub)` row exist. The "one Google per user" check has no unique index behind it, so a double-submit could still slip a cosmetic second row through — not a security hole, and not worth a migration today.

## The CSRF you don't see

There's a classic attack on linking: an attacker gets an auth code for *their own* Google, then tricks a signed-in victim into hitting the callback with it — linking the attacker's Google into the victim's account, so the attacker can later log in as the victim.

The defense is already here, from doc 03: the `state` value is minted per-flow and stored in the victim's cookie, and the callback rejects any code whose `state` doesn't match that cookie. The attacker's code carries the attacker's state; the victim's browser never held it. The link never happens. The same check that stops sign-in CSRF stops link CSRF.

## The five questions

    Where does it run?       All server-side except the consent click and the redirects.
    What shape is the data?  In: a session cookie + Google's claims. Out: one new accounts row.
    What gets stored?        A single accounts row: (userId, 'google', sub). No email, no token.
    What's computed fresh?   The session re-check at callback time — who is linking, right now.
    What's handed onward?    Nothing to a session — Mara was already signed in. Just the link, and a redirect.

## When this is the wrong shape

- **Only one direction is built.** This links Google *to* a signed-in account. The reverse — setting a password on a Google-only account — is a separate small flow, not built yet.
- **Errors are JSON mid-redirect.** A link conflict returns a `409` body in the browser, not a friendly page. The redirect-to-an-error-page is frontend work for later, same as doc 03's sign-in errors.
- **Linking isn't unlinking.** Removing a provider — and refusing to remove the *last* one, which would lock the user out — is its own feature with its own guard. Not here.

The auto-link trusts the math, because the caller is a stranger.
The manual link trusts the session, because the caller already signed in.
Both end at the same place: two proofs, one person.
