A while back I wrote up the auth *core* of my pet project (redline) — sessions, login, Google sign-in, email verification, password reset — built on vetted primitives and explained line by line so a human could actually follow it. You can read that one first; this picks up where it left off. The feature lives [here](https://github.com/mmswi/miniSocialApp/tree/feature/auth), and if you want it commit by commit, the `explanatory-docs/2FA/` folder explains each increment.

This post is about the *second factor*. The thing where Mara scans her face to finish logging in. It's built on one more vetted package — [`@simplewebauthn`](https://www.npmjs.com/package/@simplewebauthn/server) for the passkey crypto — and everything around it is hand-rolled so you can see the seams.

Same method as last time: trace one person through the whole machine.

Mara already has an account. She signs up, logs in, signs in with Google, resets her password — all of that is the first post. Now she wants a second lock on her account. She turns it on. She logs in with it. She loses her phone and gets back in with a recovery code. She buys a laptop and adds a second key. Eventually she turns the whole thing off.

Follow Mara, and the rest falls into place.

Three themes carry the whole post, so watch for them:

*   **Nothing secret ever travels.** A password is a shared secret — it has to cross the wire to be checked. A passkey isn't. The thing that proves Mara's identity never leaves her phone, not even to the server. That single property is what makes it un-phishable, and it reshapes everything downstream.

*   **The server always aims the second factor.** The dangerous bug in 2FA isn't a weak signature — it's letting the client say *whose* second factor this is. Get that wrong and the first factor becomes decorative. The fix is one rule, enforced in four places.

*   **The best defenses are holes you never built.** Like last time. A whole class of attack keeps turning out to be impossible because of the *shape* of the thing, not because of a check we added.

Let's go.

* * *

## First: what a passkey actually is

Here are the scary words, all at once:

```plaintext
Passkey.   WebAuthn.   Relying Party.   Challenge.   Attestation.   Assertion.
```

And the usual explanation: *"the authenticator signs a challenge with a private key, and the server verifies it with the public key."*

That is not an explanation. That is a list of things you are now supposed to understand.

So here is the real question underneath all of it:

```plaintext
How can Mara prove it's really her using her face —
when her face never leaves her phone,
and in a way a fake website can't copy and replay?
```

### The naive second factor, and why it's phishable

The obvious way to add a second factor is a shared secret.

A password is a shared secret. A TOTP code — the 6 digits in Google Authenticator — is a shared secret too. The server and the phone both know it, and the phone just shows the current code to Mara to type in.

```plaintext
Mara's phone:   secret = 7Q2F...  →  shows code  →  482913
redline server: secret = 7Q2F...  →  expects     →  482913
```

It works. It is also phishable.

A secret only works if it *travels*. Mara reads the code off her screen and types it into a page. So picture a fake site — `red1ine.com`, pixel-perfect. Mara lands there by mistake and logs in. It asks for her code. She types `482913`. The fake site forwards it to the *real* redline within the 30 seconds it's valid.

The thief is in.

The secret crossed the wire. It crossed Mara's eyes. Anything that travels can be intercepted or relayed.

A passkey never shares a secret at all.

### Collapse the definition: a passkey is a key pair

A passkey is two keys that belong together.

A private key. And a public key.

That is all it is.

The private key stays inside the phone's secure hardware. Forever. It never leaves. The public key is the half you are allowed to hand out.

The whole trick is what each half can do:

```plaintext
The private key can SIGN a message.
The public key can CHECK that signature — but can never produce one.
```

So Mara's phone proves it holds the private key by signing something. The server, holding only the public key, confirms the signature is genuine. But the server — or a thief who steals the server's entire database — can never sign anything *as* Mara. The public key doesn't let you. That's the asymmetry the whole feature stands on.

Nothing secret ever travels. Only the public key (safe to share) and signatures (useless to replay, as we'll see).

### Your face is not the second factor

You might think the phone scans Mara's face and sends "yes, it's Mara's face" to the server.

It does not. Her face never leaves the phone.

Face ID is a *local lock*. It unlocks the private key sitting in the phone's secure chip. That is its only job.

```plaintext
Face ID  →  unlocks the private key  →  the key signs
```

The server never sees a face. It never sees the private key. It sees a signature, and checks it against the public key it stored. Touch ID, a Windows Hello PIN, a YubiKey tap — same shape. A local gate that releases a local key.

### The challenge: why a signature can't be replayed

If the phone just signed the word "redline" every time, a thief who captured one signature could resend it forever.

So the server never asks for a signature over something fixed. It sends a **challenge** — a fresh random number — and asks the phone to sign *that*.

```plaintext
server: here is a random challenge → 9f2a7c...e1
phone:  sign(9f2a7c...e1) with the private key → <signature>
server: does <signature> check out against Mara's public key? yes.
```

Next login, a different random challenge. A captured signature is worthless — it answers a question the server will never ask again. A challenge is a one-time question; the signature is the one-time answer.

### RP ID vs origin: the part that actually kills phishing

Two identifiers trip everyone up. They sound alike. They are not.

**RP ID** — the domain the passkey belongs to. "Relying Party" is just jargon for "the site." Ours is `localhost` in dev, the real host in production.

**Origin** — the exact URL the browser is actually at, like `http://localhost:3000`.

Here is the load-bearing rule, and it's enforced by the *browser itself*, not by our code:

```plaintext
The browser binds every signature to the origin it is running on,
and refuses to use a redline passkey anywhere but redline's origin.
```

So go back to the fake `red1ine.com`. Mara's phone has a passkey for redline. The fake site asks for a signature. The browser checks: this passkey is bound to `localhost` / `redline.app`, and the page is `red1ine.com`. Mismatch. The browser **will not even offer the key.**

There's no code on screen for Mara to mistype. There's no secret to forward. The one thing that proves her identity is locked to the real origin by the browser. That is why a passkey is phishing-resistant and a typed code is not — and it's the whole reason I reached for passkeys instead of TOTP, even though TOTP is friendlier to build.

### This is a SECOND factor, not passwordless

A passkey *can* be your entire login — no password at all. That's "passwordless," and it's a different design. We are not doing that here.

Here the password (or Google sign-in) is factor one. The passkey is factor two. Both must pass. This choice isn't cosmetic — it changes the knobs we set when we build the options, and you'll see exactly where in a moment.

* * *

## Second: how we store and verify a passkey

The idea becomes rows and functions. Three concrete questions: where does the public key live, how do we verify a signature without writing crypto ourselves, and how does the server look the right key back up?

### The data model, and what's deliberately not in it

One passkey is one row.

```ts
// src/db/schema.ts
export const webauthnCredentials = pgTable('webauthn_credentials', {
  id: text('id').primaryKey(),              // the credential id from the authenticator (base64url)
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  publicKey: text('public_key').notNull(),  // base64url COSE public key — the only key we store
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  transports: jsonb('transports').$type<AuthenticatorTransportFuture[]>(),
  deviceType: text('device_type'),          // 'singleDevice' | 'multiDevice'
  backedUp: boolean('backed_up'),
  name: text('name'),                       // "iPhone 15" — a user label
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})
```

Notice what is *not* there. There's no private-key column. There's no "secret." The server never had Mara's private key and never will. The only key material here is `public_key` — the half that can check a signature but can't make one.

And notice the primary key. `id` is not a fresh uuid we generate; it's the **credential id the authenticator handed back** at enrollment. That string is how the browser refers to the key on later logins, so it *is* the natural key — we look the row up by exactly the value an assertion reports.

There's also no `twoFactorEnabled` boolean, and that's deliberate. A boolean would be a second copy of the truth, free to drift out of sync with reality. Instead, 2FA is *on* when Mara has at least one credential row:

```ts
// the login gate — a COUNT, not a flag
export const hasEnrolledPasskey = async (userId: string): Promise<boolean> => {
  const [row] = await db
    .select({ total: count() })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
  return (row?.total ?? 0) > 0
}
```

Delete her last credential and she's back to single-factor — automatically, with no flag to remember to flip. (This pays off later: "disable 2FA" becomes "delete the rows," nothing more.)

### Do NOT write the crypto

Here is the part it's tempting to build yourself.

Verifying a registration means taking the blob the browser returned and pulling the public key out of it. That blob is a **CBOR-encoded attestation object**, wrapping a **COSE-encoded public key**, wrapping signature flags and counters. Verifying a login means decoding authenticator data, re-hashing client data, and checking an ECDSA or RSA signature with exactly the right parameters.

This is the bad version:

```ts
// do not do this
const attestation = decodeCbor(response.attestationObject)
const publicKey = parseCoseKey(attestation.authData.slice(/* ...offsets... */))
// ...and now you are one off-by-one away from a CVE
```

Get one offset or one flag wrong and you either reject every honest user, or — worse — accept a forged one.

So we don't. We use `@simplewebauthn/server` for the parsing and signature math. We orchestrate; the library does the dangerous bytes. That's the entire division of labor in `src/auth/webauthn.ts` — the same reasoning that made `argon2id` and `arctic` library choices in the first post. Crypto is the thing you stand on a vetted primitive for, never hand-roll. (Its return shape changed across major versions, so the field names in our code were read off the installed `.d.ts`, not from memory.)

### The two option flags that *are* the design

Before the phone can do anything, the server hands the browser an "options" blob — the parameters for `navigator.credentials.create()` (enroll) or `.get()` (login). This is where second-factor-not-passwordless stops being a sentence and becomes two flags:

```ts
// src/auth/webauthn.ts — enrollment options
generateRegistrationOptions({
  rpID: env.RP_ID,
  rpName: env.RP_NAME,
  userID: isoUint8Array.fromUTF8String(input.userId),
  userName: input.userName,
  attestationType: 'none',
  excludeCredentials: input.existingCredentials.map(toCredentialDescriptor),
  authenticatorSelection: { residentKey: 'discouraged', userVerification: 'preferred' },
})
```

Read the last line, because it *is* the policy.

`residentKey: 'discouraged'` — do not ask the phone to store a *discoverable* credential. A discoverable credential is the passwordless feature: it lets you log in with no username at all. We don't want that. The password is factor one; the passkey only confirms it.

`userVerification: 'preferred'` — ask for the biometric (the Face ID Mara wanted) where the device can do it, but don't *hard-fail* an authenticator that can't. A bare security key with no fingerprint reader still proves possession, and possession is the second factor.

`excludeCredentials` is the list of keys Mara already enrolled — the browser greys those out so she can't register the same iPhone twice. The login side is the mirror image: instead of excluding, it passes `allowCredentials` (her credential ids), because the password already told us *who she is*, so we can name exactly which keys may answer.

Both builders generate a fresh random challenge inside the returned options. The caller's job is to stash that challenge somewhere short-lived so the verify step can demand the same one back — which is the next two sections.

### The public key: base64url, decoded only at the edge

The library hands us a public key as raw bytes — a `Uint8Array`. Postgres columns are text. So we encode to base64url on the way in:

```ts
// after a registration verifies
publicKey: isoBase64URL.fromBuffer(credential.publicKey),  // bytes → "pQECAyYgASFY..."
```

When Mara logs in later, the library needs the bytes back to check her signature. So we decode at exactly one place — the verify boundary — and nowhere else:

```ts
// inside verifyPasskeyAuthentication
credential: {
  id: input.credential.credentialId,
  publicKey: isoBase64URL.toBuffer(input.credential.publicKey),  // "pQECAyYgASFY..." → bytes
  counter: input.credential.counter,
  transports: input.credential.transports ?? undefined,
}
```

Text at rest. Bytes for one function call. The conversion never leaks into the rest of the code.

And the phishing defense from the first section becomes two arguments on that same verify call:

```ts
const EXPECTED_ORIGIN = new URL(env.APP_URL).origin  // strips a stray trailing slash

await verify({
  response: input.response,
  expectedChallenge: input.expectedChallenge,
  expectedOrigin: EXPECTED_ORIGIN,   // the URL the browser must have been at
  expectedRPID: env.RP_ID,           // the domain the key must be bound to
  requireUserVerification: false,    // honors 'preferred' — don't reject UV-less authenticators
})
```

`new URL(env.APP_URL).origin` is not fussiness. WebAuthn compares the origin byte-for-byte. A trailing slash in `APP_URL` would silently fail *every* verification, and you'd spend an afternoon wondering why valid passkeys are rejected. Deriving `.origin` strips it.

### Why we never judge the counter ourselves

Every authenticator keeps a **signature counter** — how many times it has signed. The idea is clone detection: if a counter ever goes *backwards*, two copies of the key might exist.

So the naive rule is: store the counter, reject any login where the new counter isn't strictly greater.

That rule locks Mara out.

Modern synced passkeys — iCloud Keychain, Google Password Manager — report a counter of `0`. Forever. They live in the cloud, not one chip, so the count is meaningless and they just send zero. Enforce "must increase" and every iPhone passkey fails on its second use.

So we don't enforce it. We hand the stored counter to the library, let *it* apply the spec-correct check, and simply persist whatever new value comes back. The counter is the library's to interpret; we're just its storage.

This module is deliberately dumb. It builds options, verifies responses, reads and writes rows. It does *not* know about challenges-in-Redis, login state, or who's allowed to call it. That's on purpose — it stays a pure "given a challenge, prove the key" layer, so the stateful, security-critical orchestration lives in one place you can audit. That place is the next three sections. If you ever find auth-flow logic creeping into this file, that's the smell; push it back out.

* * *

## Third: the gap between "password OK" and "you're in"

Mara has a passkey now. So her login has two steps, not one.

Step one: email and password. Correct. Step two: her phone signs a challenge. Between those two steps, something has to remember her.

Without 2FA, login was one moment:

```plaintext
password correct → mint a session → set the cookie → done
```

With 2FA, there's a gap in the middle:

```plaintext
password correct → ??? → second factor → mint a session → done
```

What lives in the `???`. Mara has proven one factor and not the second. She is **half-authenticated** — more than a stranger, less than logged in. You can't give her a session yet; a session *is* "fully logged in." But you have to remember *something* across her next few requests, or step two has no idea who's knocking.

### The naive version, and why it quietly defeats 2FA

Here's the tempting shortcut. The `/login` handler just checked Mara's password, so it knows her userId. Hand that to the browser and let the second-factor requests send it back:

```plaintext
POST /login            → { mfaRequired: true, userId: "mara-uuid" }   ← BAD
POST /2fa/verify         { userId: "mara-uuid", assertion: ... }       ← BAD
```

Read that second line again. The userId is coming *from the client*.

Now picture an attacker. They have their own account and their own passkey. They know Mara's userId (it leaked, or it's in a URL somewhere). They call the verify endpoint with **Mara's userId** and **their own** assertion — signed by **their own** phone, which they can Face-ID all day. If the server trusts that userId and just checks "is this a valid assertion for *some* registered credential," the attacker walks into Mara's account.

The password — the first factor — just became decorative. The second factor authenticated the *attacker's* finger against the *attacker's* key, but logged them into *Mara's* account. The bug is one word: the userId came from the request.

### The fix: the second factor's identity comes only from server state

The rule that makes 2FA real, and the second of our three themes:

```plaintext
After the password passes, the userId for the second factor
comes ONLY from server-side state — never from the request.
```

So at `/login`, when the password is right and Mara has a passkey, we don't hand her a userId. We mint a **pending-MFA token** and keep the userId on *our* side, in Redis, under the token's hash:

```ts
// src/auth/mfa.ts
export const createPendingMfa = async (input: { userId: string }) => {
  const rawToken = generateToken()                          // 256-bit random
  const value = { userId: input.userId, challenge: null }
  await redis.set(pendingKey(rawToken), JSON.stringify(value), 'EX', PENDING_MFA_TTL_SECONDS)
  return { rawToken, expiresAt: new Date(Date.now() + PENDING_MFA_TTL_MS) }
}
```

The raw token goes to Mara in a cookie. The userId stays in Redis. When step two arrives, the server reads the userId back *from Redis*, keyed by the token in her cookie. The attacker can send any userId they like in the body — nobody reads it. The only userId that matters is the one *we* wrote, that *only Mara's cookie* can point at. The first factor is load-bearing again.

### Why it's a different cookie from the session

Mara's pending token rides a cookie called `redline_mfa`. Not the session cookie. On purpose.

Here's the trap: if the half-auth token were accepted by `getSessionUser`, then "password correct, second factor still pending" would already *be* "logged in" — and the second factor would be skipped entirely. So the pending token lives in its own cookie, resolved only by `loadPendingMfa`, and the session resolver never looks at it.

```ts
// src/auth/cookies.ts
export const MFA_COOKIE_NAME = 'redline_mfa'   // separate from SESSION_COOKIE_NAME
```

Two cookies. One means "logged in." The other means "halfway there." They never cross.

### Same hash-at-rest trick, single-use, bounded

The pending token is a key — whoever holds it can finish Mara's login — so we treat it exactly like the session token from the first post. The cookie holds the raw token; Redis stores only its `sha256` hash as the key:

```ts
const pendingKey = (rawToken: string) => `mfa:pending:${hashToken(rawToken)}`
```

A Redis leak hands the attacker a list of hashes that key nothing without the raw token, which only ever lived in Mara's cookie. (Why sha256 and not argon2? Same split as the first post: the token is 256 bits of randomness, not a guessable password — nothing to brute-force, so the fast hash is correct.)

Two more properties keep the gap small. It's **single-use** — deleted the instant the second factor succeeds, so a finished login can't be replayed (we consume only on success, so a failed Face ID leaves the token alive for a retry). And it's **bounded** — a 10-minute TTL, so the half-authenticated state can't linger. Plenty of time to glance at a prompt and tap; after that it evaporates and Mara starts over. The challenge gets written into this same entry later, and even *that* write re-reads the userId from Redis rather than trusting the caller — the invariant holds at every step.

This whole dance exists *because* we chose 2FA. A passwordless design has no "half" state to hold — the assertion either logs you in or it doesn't. The gap is the price of a first factor, and the pending token is how you guard it.

* * *

## Fourth: recovery codes, for when the phone goes in the lake

Mara enrolled a passkey. Her account is safer. It's also more fragile in exactly one way: the passkey lives in one device's secure hardware. Drop that phone in a lake, and the private key is at the bottom of the lake with it.

### Why "reset my passkey" cannot exist

With a password, losing it is fine. You click "forgot password," prove you own the email, set a new one — the server always *could* set a new password, because the server controls it. A passkey is the opposite. The server never had the private key. It can't reset what it never held. There is no "email me a new passkey."

So the naive recoveries don't work:

```plaintext
"Let support flip 2FA off."           → now a support social-engineer is your second factor.
"Email a magic link to disable 2FA."  → now your email is your second factor, and email is phishable.
```

Each quietly hands the second factor back to something weaker. The whole point was to *not* depend on a phishable channel. We need a backup as strong as the passkey, handed to Mara up front, while she still has the device. That's a recovery code.

A recovery code is a one-time password you were given in advance. That is all it is. We generate ten the moment Mara enrolls her first passkey, show them once, and she saves them somewhere safe. Months later, phone in the lake, she types one in instead of using her passkey. It logs her in. Then it's dead — used up, never again.

### What a code looks like, and why

```plaintext
A7KM-9QR3-FXP2
```

Three groups of four, from a deliberately small alphabet:

```ts
const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0 O 1 I L
```

Look at what's missing: no `0` or `O`, no `1` or `I` or `L`. Those are the characters people mistype when reading off paper. Leave them out and a misread can't accidentally land on a *different* valid code. Each code is 12 characters from 32 symbols — about 60 bits of entropy, unguessable, and single-use and rate-limited on top, so there's nothing to brute-force.

The dashes are just for the eye. When Mara types it back, we don't care about her dashes or her caps lock:

```ts
const normalizeRecoveryCode = (rawCode: string): string =>
  rawCode.toUpperCase().replace(/[\s-]/g, '')
```

`a7km9qr3fxp2`, `A7KM-9QR3-FXP2`, `A7KM 9QR3 FXP2` all canonicalize to the same thing before we hash it. The stored hash and the typed-back code always meet in one shape.

### Stored hashed, salted with the userId

We never store the codes themselves — a database leak would otherwise hand the attacker ten working 2FA-bypasses per user. So we store only a hash, salted with the userId:

```ts
const recoveryCodeId = (userId: string, normalizedCode: string): string =>
  hashToken(`${userId}:${normalizedCode}`)   // sha256(userId + ':' + code)
```

Why salt with the userId? A bare `sha256(code)` would be global — two users who happened to get the same code would collide on the primary key, and identical codes would produce identical hashes, leaking that they match. Salting per-user scopes each hash to its owner. And a code is only ever looked up in the context of a *known* user — at login, the one from the pending-MFA token, never the request. Same invariant, carried through.

### Single-use, enforced by the database

"Each code works exactly once" sounds like a rule you check in code. It isn't. It's enforced in one query:

```ts
export const consumeRecoveryCode = async (userId: string, rawCode: string): Promise<boolean> => {
  const id = recoveryCodeId(userId, normalizeRecoveryCode(rawCode))
  const consumed = await db
    .update(recoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(recoveryCodes.id, id), eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
    .returning({ id: recoveryCodes.id })
  return consumed.length > 0
}
```

The `isNull(usedAt)` in the WHERE is the whole trick. It says: mark this code used *only if it is currently unused*. The database does the check and the write in one atomic step. So picture a double-submit — Mara fat-fingers the button twice, two requests race. Both compute the same code id, both try to update `WHERE used_at IS NULL`. The database lets exactly one match: the first sets `used_at`, the second now finds nothing matching and updates zero rows. `.returning()` tells us which we were — one row means we consumed it, zero means unknown-or-already-spent. No read-then-write gap for a race to slip through. (It's the same shape as the `23505` unique-constraint trick from the first post: let the database be the atomic judge instead of checking-then-acting.)

The codes are shown exactly once. `generateRecoveryCodes` returns the raw codes for the route to display and keeps only the hashes — there is no "show me my codes again" endpoint, because there's nothing to show; we threw the originals away on purpose. Regenerating is the same call: it deletes the old batch in a transaction and writes a fresh ten, so an old printout stops working the moment a new one is issued.

The honest cost: a recovery code is a bearer secret. Whoever holds it passes the second factor — that's the entire job — so a leaked code is as dangerous as a leaked password, minus the username. That's the deal we accept for not locking Mara out forever, and we blunt it the obvious ways (single-use, rate-limited, regeneration burns the old set, and we tell her to store them like passwords). If you could guarantee every user a *second* hardware key in a safe, you'd sidestep the printable bypass entirely — but most people don't have a spare YubiKey in a drawer. Mara doesn't. So she gets codes.

* * *

## Fifth: wiring the two-factor login

We have all the parts — the service that verifies a passkey, the pending-login token, recovery codes. This is the assembly: the actual endpoints Mara's browser calls. Two journeys, turning 2FA on and then logging in with it.

### Login now has two endings

Before 2FA, `loginWithPassword` had one outcome: a session. Now it has two, and the type says so out loud:

```ts
// src/auth/password-auth.ts — the two outcomes named once, so no bare 'mfa_required' string drifts around
export const PASSWORD_LOGIN_STATUS = {
  authenticated: 'authenticated',
  mfaRequired: 'mfa_required',
} as const

export type PasswordLoginResult =
  | { status: typeof PASSWORD_LOGIN_STATUS.authenticated; user: User; session: CreatedSession }
  | { status: typeof PASSWORD_LOGIN_STATUS.mfaRequired; userId: string }
```

A correct password is no longer the end of the story. If the user has a passkey, the function stops and returns `mfaRequired` with *only* the userId — no session:

```ts
if (await hasEnrolledPasskey(account.userId)) {
  return { status: PASSWORD_LOGIN_STATUS.mfaRequired, userId: account.userId }
}
```

One detail matters for security: this branch is reached *only after the password verified*. So `mfaRequired` can never tell an attacker "this email has 2FA" — they'd have needed the right password to see it. (The status values are a named `const` object rather than bare strings on purpose — one source of truth, so a typo at any call site is a compile error instead of a silent miss.)

The `/login` route reads the discriminated result and forks:

```ts
// src/auth/routes.ts
if (result.status === PASSWORD_LOGIN_STATUS.mfaRequired) {
  const pending = await createPendingMfa({ userId: result.userId })
  setMfaCookie(reply, pending.rawToken, pending.expiresAt)
  return reply.send({ mfaRequired: true })   // ← no session cookie on this path
}
setSessionCookie(reply, result.session.rawToken, result.session.expiresAt)
return reply.send({ user: publicUser(result.user, linkedProviders) })
```

The fork is the whole point: one branch hands out a session, the other hands out a *pending* token and asks for more.

### Turning 2FA on: the enrollment round trip

Mara is already signed in. She clicks "add a passkey." Two requests:

```plaintext
POST /auth/2fa/register/options   (her session cookie proves who she is)
  → build options { challenge, excludeCredentials, rp, ... }
  → store the challenge in Redis, keyed by her userId
  → return options
browser: navigator.credentials.create(options)   ← Face ID; makes the key pair
POST /auth/2fa/register/verify    { response, name? }
  → take the stored challenge back (GETDEL — single use)
  → verifyPasskeyRegistration(response, challenge)
  → store the public key
  → if this is her FIRST passkey: generate 10 recovery codes, return them ONCE
```

Notice where the enrollment challenge lives. Mara has a session here, so we key it by her userId, and read-and-delete it atomically so it can only be spent once:

```ts
// src/auth/webauthn-challenge.ts
const registrationChallengeKey = (userId: string) => `webauthn:challenge:reg:${userId}`
export const takeRegistrationChallenge = (userId: string) =>
  redis.getdel(registrationChallengeKey(userId))   // read-and-delete, atomic, single-use
```

That's different from the *login* challenge, which has no session to key on and rides the pending-MFA entry instead. Same idea — a server-issued challenge the verify step demands back — keyed differently because enrollment knows the user and login doesn't yet.

The recovery codes are minted *here*, at the first passkey:

```ts
const isFirstPasskey = !(await hasEnrolledPasskey(active.userId))
await storePasskey({ userId: active.userId, registration: verified, name: body.name ?? null })
const recoveryCodes = isFirstPasskey ? await generateRecoveryCodes(active.userId) : undefined
return { credentialId: verified.credentialId, recoveryCodes }
```

The moment 2FA turns on is the moment Mara could get locked out — so that's the moment she gets her backup. Check `isFirstPasskey` *before* storing, or the new row makes every enrollment look like the first.

### Logging in with 2FA: the second round trip

Now the everyday path:

```plaintext
POST /auth/login           → password OK, has passkey → { mfaRequired: true }
                             + redline_mfa cookie, NO session
POST /auth/2fa/authenticate/options   (reads redline_mfa cookie)
  → load the pending login → her userId
  → build options { challenge, allowCredentials: her keys }
  → attach the challenge to the pending entry
  → return options
browser: navigator.credentials.get(options)   ← Face ID; signs the challenge
POST /auth/2fa/authenticate/verify    { response }
  → load pending → { userId, challenge }
  → the asserted credential must belong to THIS user        ← the guard
  → verifyPasskeyAuthentication(response, challenge, storedKey)
  → update the counter
  → finishMfaLogin: burn pending, clear cookie, MINT SESSION
```

Every one of those `/2fa/authenticate` handlers begins the same way — by resolving the cookie to a pending login, server-side, with the userId coming out of Redis and never out of the request body. That's the invariant from the third section, now enforced at every route that finishes a login.

### The guard that makes the second factor real

Here's the line the whole feature hinges on:

```ts
const credential = await getPasskey(body.response.id)
if (credential === null || credential.userId !== pending.userId) {
  throw badRequest('webauthn_unknown_credential', 'That passkey is not registered here.')
}
```

Picture the attack one more time. An attacker has *their own* account and *their own* passkey. They get hold of the victim's pending cookie but sign the challenge with their *own* Face ID, their *own* key. Without this check, the server might think "this is a valid assertion for a real, registered passkey" and let them in — as the victim.

The check stops it cold. The asserted credential's `userId` must equal the pending login's `userId`. The attacker's key belongs to the attacker, not the victim. Mismatch. Rejected *before* we even verify the signature. A valid assertion for the wrong account is worth nothing.

### Session creation has exactly one home

In the whole 2FA flow, `createSession` runs in one place — the shared tail both success paths call:

```ts
const finishMfaLogin = async (reply, req, rawMfaToken, userId) => {
  await consumePendingMfa(rawMfaToken)   // burn the pending token (single-use)
  clearMfaCookie(reply)                  // drop the half-auth cookie
  const session = await createSession({ userId, ip: req.ip, userAgent: ... })
  setSessionCookie(reply, session.rawToken, session.expiresAt)
  // ...return the public user
}
```

Passkey login calls it after a verified assertion. Recovery-code login calls it after a consumed code (same shape, minus the signature: `consumeRecoveryCode` instead of `verifyPasskeyAuthentication`, then the very same tail). Nowhere else in the flow is a session minted. One door to "you're fully in," and both factors have to walk through it.

Five routes for "log in" is a lot of surface, and it's tempting to read it as over-engineering. But WebAuthn *is* a challenge/response handshake: the server issues a challenge, the device signs it, the server verifies that exact challenge. That's inherently two round trips per phase — options, then verify — and you can't collapse them without throwing away the replay protection the challenge buys. The endpoint count isn't accidental complexity; it's the protocol's shape made honest. (Putting them in their own `twofa-routes.ts` plugin instead of piling onto `routes.ts` is just housekeeping, so the core auth file stays about passwords and sessions.)

* * *

## Sixth: managing passkeys, and the step-up that guards the off switch

Mara turned on 2FA. Now she lives with it. She buys a laptop and enrolls a second key. She names her phone "iPhone." She sells the laptop and removes its key. One day she wants 2FA off entirely. Every one of those is a management action. Most are ordinary. One is dangerous. This section is about telling them apart.

### The ordinary actions

Listing, renaming, removing-one. Mara is signed in; her session proves who she is; the server edits her own rows:

```plaintext
GET    /auth/2fa/credentials       → her passkeys + how many recovery codes are left
PATCH  /auth/2fa/credentials/:id   → rename one
DELETE /auth/2fa/credentials/:id   → remove one (but see below)
```

Two small things keep these safe. The list never leaks key material — the Security page sees a projection (id, name, backedUp, timestamps), never the public key, counter, or userId, the same discipline as `publicUser` for accounts. And edits are scoped to the owner: rename and delete both filter by `userId`, so a credential id alone can't touch someone else's key. If the row doesn't belong to Mara, nothing matches, and she gets a clean "no such passkey" — never a peek at whether that id exists for someone else.

### The one dangerous action: dropping to zero

Here's the asymmetry that matters. Removing *a* passkey when Mara has two is fine — she still has one, 2FA is still on. Removing her *last* passkey is different: that turns 2FA off. So does the explicit "disable 2FA." Those two — remove-the-last and disable — are the dangerous ones, because they take the account from protected to unprotected.

So `DELETE` simply refuses to be the off switch:

```ts
if ((await countPasskeys(active.userId)) <= 1) {
  throw conflict('last_passkey', 'This is your last passkey. Disable 2FA to remove it.')
}
```

You cannot quietly delete your way to zero. The last step has to go through `/disable`, where there's a stronger gate.

### Why a valid session is not enough

Picture the attack this gate exists for. Someone steals Mara's live session — a cookie lifted off an unlocked laptop, a hijacked tab. As far as the server can tell, they're signed in as Mara. If "disable 2FA" only needed a session, they'd just turn it off, then change her password, and the second factor that was supposed to protect her is gone — removed by the very session it was meant to backstop.

So disabling 2FA demands something the session-thief doesn't have: a **fresh factor**, proven *right now*.

```ts
const proven = await proveFreshFactor({ userId, sessionId, proof })
if (!proven) {
  throw forbidden('step_up_failed', 'Confirm a passkey or a recovery code to disable 2FA.')
}
await disableTwoFactor(active.userId)
```

This is **step-up**: a valid session gets you to the door, but a sensitive action makes you prove a factor again before it opens. A fresh factor is one of two things, because Mara might be in either situation. A passkey assertion is the clean path — she taps Face ID, signs a fresh challenge, nothing spent; the challenge for it is issued by `/stepup/options` and keyed to *her session*, so a challenge minted for one session can't be redeemed by another. A recovery code is the fallback, for when she's disabling 2FA *because* she lost the device. The session-thief has neither — they hold a cookie, not the phone and not the printed codes. And the assertion path reuses the *exact* ownership check from the login flow: a fresh factor has to be *Mara's* fresh factor.

When step-up passes, `disableTwoFactor` wipes 2FA in one transaction — both `webauthnCredentials` and `recoveryCodes` for that user, together, so there's never a half state where the keys are gone but stale codes linger. And because "2FA is enabled" is *derived* from the credential count, deleting the keys is all it takes to flip the login gate back to single-factor. There's no separate flag to forget. (That design choice from the second section paying off, exactly as promised.)

Step-up is a deliberate speed bump, and the art is putting it only where it earns its friction. Renaming a passkey doesn't get it — relabeling "iPhone" to "Work phone" changes no security posture, so demanding Face ID would be theater. Removing a non-last key doesn't either: 2FA stays on, the blast radius is small. We spend the friction only where the account goes from protected to unprotected. Guard the off switch; leave the light switches alone.

* * *

## Seventh: the browser's half of the handshake

Everything so far has been the server. Now the part Mara actually touches. She types her password, a passkey prompt appears, she looks at her phone, she's in. Three button-presses of UI on top of all that backend — and one genuinely tricky moment.

### The fork that sends her to /2fa

The API can now answer login two ways, and the type says so:

```ts
// web/src/lib/api.ts
export type LoginResult = { user: PublicUser } | { mfaRequired: true }
```

So the login page reads which branch it got and routes accordingly:

```ts
// web/src/pages/LoginPage.tsx
const result = await API_login({ email, password })
if ('mfaRequired' in result) {
  navigate('/2fa')   // password was right; the second factor is next
  return
}
await refresh()
navigate('/')         // no 2FA — straight in
```

Notice what the client does *not* receive on the `mfaRequired` branch: no token, no userId, nothing. The pending-MFA cookie was set by the server, httpOnly, invisible to JavaScript. The browser just knows "go to /2fa," and the cookie rides along automatically on the next request. (The invariant again, seen from the client's side: the browser literally cannot name *whose* login this is, because it was never told.)

### The three-step dance

On `/2fa`, Mara taps "Verify with passkey." That kicks off a handshake the page orchestrates in three moves:

```ts
// web/src/pages/TwoFactorPage.tsx
const options = await API_2faAuthenticateOptions()                  // 1. ask the server (network)
const assertion = await startAuthentication({ optionsJSON: options }) // 2. hand to the device (Face ID)
await API_2faAuthenticateVerify(assertion)                          // 3. send the signed result (network)
await finishLogin()
```

Step 2 is the only line that isn't a network call. `startAuthentication` is from `@simplewebauthn/browser` — the wrapper around `navigator.credentials.get()`, the thing that actually makes the OS show the Face ID sheet, unlock the private key, and sign the server's challenge. That's why the device step lives in the *page*, not in `api.ts`: the `API_` functions are network calls and nothing else (that prefix is a promise), while the browser ceremony is a different kind of operation, so it sits where the user gesture is.

And it *is* a gesture — a button, not an auto-run. The page could fire `startAuthentication` on mount; it doesn't. Browsers gate the WebAuthn prompt behind a real click, partly so a page can't silently pop a credential request the instant you land on it. So `/2fa` shows a button, and the handshake starts when Mara presses it. The gesture is both a browser requirement and the honest UX: she *chose* to authenticate.

### When the phone is in the lake

Mara might not have her passkey — lost phone, wiped laptop. So the page has a second door: "Use a recovery code instead" swaps the passkey button for a text field, and one of the codes goes to the same finish line, minus the device. Both paths end in `finishLogin`, which does the one thing the client *can* do once the cookie is set: re-ask the server who it is.

```ts
const finishLogin = async () => {
  await refresh()   // GET /auth/me — the server is the source of truth
  navigate('/')
}
```

The session cookie is httpOnly — the client can't read it to know "am I logged in now?" So it asks. `refresh()` pulls `/auth/me`, the auth context flips to authenticated, and Mara lands on the dashboard.

A passkey login can fail two very different ways, and the page flattens them into one human sentence. An `ApiError` means the *server* said no (expired pending login, rejected assertion) — show its message. A `WebAuthnError` means the *browser ceremony* broke — Mara hit cancel, the sensor timed out, there's no matching credential on this device. That never reached the server, so there's no server message; the page supplies its own and points her at the recovery-code escape hatch.

The temptation here is to make the frontend smarter — cache the user, decode something, track "2FA pending" in React state. Resist it. The client holds no secret and no authority: it can't read the httpOnly cookies, it can't verify a passkey, it can't decide who's logged in. Its whole job is to route to the right screen, trigger the device prompt on a click, and ask the server what's true afterward. Every time the frontend is tempted to *know* something about auth, the right move is to ask `/auth/me` instead. A dumb client is the secure client.

### The one place that rule breaks: the show-once problem

Enrolling is the mirror of logging in — same three-step shape, different verb in the middle. `startRegistration` (the create-time twin of `startAuthentication`) wraps `navigator.credentials.create()`: the OS prompts for Face ID, the device generates a fresh key pair in its secure hardware, and hands back the *public* key. The server stores it. Mara has a passkey.

But when she enrolls her *first* one, the server turns 2FA on and mints ten recovery codes — and returns them in that one verify response, never again:

```ts
const result = await API_2faRegisterVerify({ response, name })
if (result.recoveryCodes !== undefined) {
  setNewCodes(result.recoveryCodes)   // present them NOW; there is no second chance
}
```

Why only once? Because the server stores codes hashed — it cannot show them again because it threw the originals away on purpose. There is no "resend my codes" endpoint, because there is nothing to resend.

So the UI has a duty the rest of the page doesn't: it must make Mara *stop and save them*. The codes live in component state, shown in a loud amber box, dismissed only by an explicit "I've saved them." Reload the page and they're gone — exactly as they should be.

This is the one screen where the "dumb client" rule inverts. Almost everywhere in this system, losing a client-side value is harmless — the server is the truth, just ask again. The recovery codes are the single exception: for one render, the client is the *only* holder of the plaintext, and if the page fails to make Mara save them, nothing else can recover them. So here UX *is* security. The loud box, the explicit acknowledge, the refusal to tuck the codes behind a reload — those aren't polish, they're the safeguard. Get the show-once moment wrong and you've built a 2FA that quietly locks people out the first time they lose a phone. Everywhere else the client can be dumb; here it has to be insistent.

(Disabling, from the client side, is just the login handshake pointed at a destructive action: `stepup/options → startAuthentication → disable`, or a recovery code instead. The server enforces that a session alone isn't enough; the page only collects the fresh factor and passes it along. Add, remove, rename, disable all run through one busy/error wrapper, so the page has many actions but one way to be busy and one way to fail.)

* * *

## The gap I didn't close: Google sign-in doesn't enforce 2FA

Honesty, the same as the first post earned. There's a hole here I left open on purpose, and it's worth naming plainly rather than hoping you don't notice.

**A user with a passkey can still log in through "Continue with Google" without the second factor.**

The reason is structural. The password path runs *through our server* — `loginWithPassword` returns `mfaRequired`, and the route withholds the session. The Google path is a redirect flow that mints a session directly in the callback (that's the whole OAuth dance from the first post). Gating it means redirecting *out* of the callback to a frontend `/2fa` step, carrying the pending cookie, before the session is set — real extra work that I scoped out of this slice.

So the threat model this 2FA actually defends is the password one: a leaked or reused password no longer earns an account on its own. A determined attacker who can complete Mara's Google OAuth is outside what this slice stops. That's a real limitation, not an oversight — and it's exactly the kind of thing that belongs in a post, not buried in a commit. Closing it is a Google-callback interstitial, and it's the natural next increment.

Also deliberately out of scope: passwordless passkey login (this is second-factor only), TOTP as an alternate factor, and admin-mandated enforcement.

* * *

## An honest word on testing

You cannot drive a real authenticator from a test. The biometric and the secure chip aren't scriptable — there is no way to make Face ID say yes inside `bun test`. So **there is no real end-to-end passkey test, and nothing in this codebase claims to be one.**

What *is* tested is the state machine we own: pending-token issuance, expiry, and single-use; the ownership guard; counter updates; recovery-code consumption; step-up gating; and — added after a reviewer pointed out it had never actually executed — that the rate limit really binds on the doubly-nested `/auth/2fa` routes. The `@simplewebauthn` verify is mocked at exactly one boundary (it's injected as a default argument precisely so a test can replace it), and the **recovery-code path is the honest no-mock end-to-end** for both login and disable — a full round trip through the route machine without a real authenticator.

The passkey-assertion *success* path is covered at the service layer and named honestly everywhere it appears. The thing left for a human is a five-minute manual smoke on `localhost` (a WebAuthn secure context): real Face ID enroll → log out → log in with the passkey → disable with step-up. That's the one part the mocks can't prove, and it's flagged as such.

I'd rather tell you the seam exists than paper over it with a test that pretends to drive a sensor it can't.

* * *

## What the whole thing taught me

Trace Mara through the second factor and a few ideas keep doing the work.

**Nothing secret has to travel.** A password is checked by sending it; a passkey is checked without ever moving the private key off the phone. That one difference is the entire reason a passkey survives a phishing site and a typed code doesn't — the browser binds the signature to the origin, and a fake site has nothing to relay.

**The first factor is only load-bearing if the server aims the second.** The userId for the second factor comes from server-side state, never the request — at the pending token, at every login route, at step-up. Get that one rule wrong and the password becomes decoration; an attacker passes *their* factor against *your* account. Four places, one invariant.

**The best defenses are still holes you never built.** There's no "reset my passkey" because the server never held the key — so there's no reset endpoint to abuse. "2FA is on" is derived from a row count, so there's no boolean to drift. A stolen session can't strip 2FA, because the off switch demands a fresh factor the session-thief doesn't have. You don't add those defenses; you build a shape with no room for the attack.

And the whole machine, in three beats:

```plaintext
The password proves who you are, once — and a passkey-holder gets no session for it alone.
The device signs a fresh challenge your face unlocked but never sent, and the server checks it aims at the right account.
Lose the phone and ten one-time codes get you back; steal the session and the lock still won't come off.
```
