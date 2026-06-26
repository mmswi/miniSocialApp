# How we store and verify a passkey

> Increment: `feature/auth` — 2FA, the data model (M1) and the prove-the-key service (M2).
> Files: `src/db/schema.ts`, `src/lib/env.ts`, `src/auth/webauthn.ts`.

The previous doc built the idea: a key pair, the private half locked in the phone, the public half on the server, a fresh challenge signed each time.

Now the idea becomes rows and functions.

Three questions to answer concretely:

- Where does the public key live, and in what form?
- How do we verify a signature without writing crypto ourselves?
- How does the server later look the right key back up?

Same person. Mara, turning on 2FA with her iPhone.

---

## First: the data model

One passkey is one row.

```ts
// src/db/schema.ts
export const webauthnCredentials = pgTable('webauthn_credentials', {
  id: text('id').primaryKey(),           // the credential id from the authenticator (base64url)
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  publicKey: text('public_key').notNull(), // base64url COSE public key — the only key we store
  counter: bigint('counter', { mode: 'number' }).notNull().default(0),
  transports: jsonb('transports').$type<AuthenticatorTransportFuture[]>(),
  deviceType: text('device_type'),       // 'singleDevice' | 'multiDevice'
  backedUp: boolean('backed_up'),
  name: text('name'),                    // "iPhone 15" — a user label
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
})
```

Notice what is *not* there.

There is no private key column. There is no "secret." The server never had Mara's private key and never will. The only key material here is `public_key` — the half that can check a signature but can't make one.

Notice the primary key.

`id` is not a fresh uuid we generate. It is the **credential id the authenticator handed back** at enrollment. That string is how the browser refers to the key on later logins, so it *is* the natural key — we look the row up by exactly the value an assertion reports.

### "Is 2FA on?" is a question we never store the answer to

There is no `twoFactorEnabled` boolean.

A boolean would be a second copy of the truth, free to drift out of sync with reality.

Instead, 2FA is *on* when Mara has at least one credential row:

```ts
// the login gate — a COUNT, not a fetch
export const hasEnrolledPasskey = async (userId: string): Promise<boolean> => {
  const [row] = await db
    .select({ total: count() })
    .from(webauthnCredentials)
    .where(eq(webauthnCredentials.userId, userId))
  return (row?.total ?? 0) > 0
}
```

Delete her last credential and she's back to single-factor — automatically, with nothing to remember to flip.

### The config the keys are bound to

Two values, from the previous doc, now live in env:

```ts
// src/lib/env.ts
RP_ID: z.string().default('localhost'),  // the domain a credential binds to
RP_NAME: z.string().default('redline'),  // the label shown in the OS passkey prompt
```

The origin — the exact URL the browser is at — is the `APP_URL` we already had. We'll use both in a moment.

(There's also a `recovery_codes` table in this migration: `sha256(code)` at rest, single-use, with a `used_at` stamp. It's the lose-your-phone backup. It's not wired up yet — a later increment uses it.)

---

## Second: do NOT write the crypto

Here is the part it's tempting to build yourself.

Verifying a registration means taking the blob the browser returned and pulling the public key out of it.

That blob is a **CBOR-encoded attestation object**, wrapping a **COSE-encoded public key**, wrapping signature flags and counters. Verifying a login means decoding authenticator data, re-hashing client data, and checking an ECDSA or RSA signature with exactly the right parameters.

This is the bad version:

```ts
// do not do this
const attestation = decodeCbor(response.attestationObject)
const publicKey = parseCoseKey(attestation.authData.slice(/* ...offsets... */))
// ...and now you are one off-by-one away from a CVE
```

Get one offset or one flag wrong and you either reject every honest user, or — worse — accept a forged one.

So we don't.

We use `@simplewebauthn/server` for the parsing and signature math. We orchestrate; the library does the dangerous bytes. That's the whole division of labor in `src/auth/webauthn.ts`.

And because the library's exact return shape has changed across major versions, the field names in our code were read off the installed `.d.ts`, not from memory.

---

## Third: building the options

Before the phone can do anything, the server hands the browser an "options" blob — the parameters for `navigator.credentials.create()` (enroll) or `.get()` (login).

This is where the second-factor-not-passwordless choice becomes real flags:

```ts
// src/auth/webauthn.ts — enrollment options
export const buildPasskeyRegistrationOptions = (input: {...}) =>
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

Read the two flags on the last line, because they *are* the design:

`residentKey: 'discouraged'` — do not ask the phone to store a *discoverable* credential. A discoverable credential is the passwordless feature: it lets you log in with no username at all. We don't want that. The password is factor one; the passkey only has to confirm it.

`userVerification: 'preferred'` — ask for the biometric (the Face ID Mara wanted) where the device can do it, but don't *hard-fail* an authenticator that can't. A bare security key with no fingerprint reader still proves possession, and possession is the second factor.

`excludeCredentials` is the list of keys Mara already enrolled. The browser greys those out so she can't register the same iPhone twice.

The login side is the mirror image:

```ts
// authentication options
generateAuthenticationOptions({
  rpID: env.RP_ID,
  allowCredentials: input.allowCredentials.map(toCredentialDescriptor),
  userVerification: 'preferred',
})
```

`allowCredentials` is the list of Mara's credential ids. Because the password already told us *who she is*, we can tell the browser exactly which keys are allowed — so it only offers a key that can actually satisfy this account.

Both builders generate a fresh random **challenge** inside the returned options. The caller's job is to stash `options.challenge` somewhere short-lived (Redis) so the verify step can demand the same one back. That stashing is the next increment.

---

## Fourth: the public key, base64url, decoded only at the edge

The library hands us a public key as raw bytes — a `Uint8Array`.

Postgres columns are text. So we encode the bytes to a base64url string on the way in:

```ts
// after a registration verifies
publicKey: isoBase64URL.fromBuffer(credential.publicKey),  // bytes → "pQECAyYgASFY..."
```

That string is what sits in `public_key`.

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

### Origin and RP, checked on every verify

This is the phishing defense from the previous doc, now as two arguments:

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

`new URL(env.APP_URL).origin` is not fussiness. WebAuthn compares the origin byte-for-byte. A trailing slash in `APP_URL` would silently fail every single verification, and you'd spend an afternoon wondering why valid passkeys are rejected. Deriving `.origin` strips it.

---

## Fifth: why we never judge the counter ourselves

Every authenticator keeps a **signature counter** — how many times it has signed. The idea is clone detection: if a counter ever goes *backwards*, two copies of the key might exist.

So the naive rule is: store the counter, and reject any login where the new counter isn't strictly greater.

That rule locks Mara out.

Modern synced passkeys — iCloud Keychain, Google Password Manager — report a counter of `0`. Forever. They live in the cloud, not one chip, so the count is meaningless and they just send zero.

If we enforced "must increase," every iPhone passkey would fail on its second use.

So we don't enforce it. We hand the stored counter to the library, let *it* apply the spec-correct check, and simply persist whatever new value it returns:

```ts
// after a successful assertion
export const touchPasskeyCounter = async (credentialId: string, newCounter: number) => {
  await db
    .update(webauthnCredentials)
    .set({ counter: newCounter, lastUsedAt: new Date() })
    .where(eq(webauthnCredentials.id, credentialId))
}
```

The counter is the library's to interpret. We're just its storage.

---

## What the verify wrappers return, and why that shape

`verifyPasskeyRegistration` and `verifyPasskeyAuthentication` don't return the library's sprawling result object. They return the small thing the caller needs, or `null`:

    registration verified   → { credentialId, publicKey, counter, transports, deviceType, backedUp }
    registration failed      → null
    authentication verified  → { newCounter }
    authentication failed     → null

`null` is the signal a route turns into a clean `400`. No exceptions thrown across the boundary, no half-parsed objects leaking out.

And the verify function is **injectable** — each wrapper takes the real `@simplewebauthn` verify as a default argument that a test can replace:

```ts
export const verifyPasskeyRegistration = async (
  input: {...},
  verify: typeof verifyRegistrationResponse = verifyRegistrationResponse,
) => { ... }
```

This matters because you cannot drive Face ID from a unit test. There is no honest end-to-end passkey test — the biometric and the secure chip aren't scriptable. So we test the parts we own (the option shapes, the base64url round-trip, the origin/RP we pass through, the store) and feed the verify boundary a stub. The tests say exactly that, and claim nothing they can't prove.

---

## The five questions

    Where does it run?
    Option building + verification: the server. The actual key work: the device.

    What shape is the data?
    A public key as base64url TEXT in Postgres; bytes only at the verify call.

    What gets stored?
    One row per passkey (public key, counter, transports, label). Never a private key.

    What's computed fresh?
    A fresh challenge per option blob; a fresh signature check per login.

    What's handed on?
    Registration → fields to store. Authentication → the new counter, then a session.

---

## When this layer is the wrong shape

This module is deliberately dumb. It builds options, verifies responses, reads and writes rows. It does **not** know about challenges-in-Redis, login state, or who's allowed to call it.

That's on purpose — it stays a pure "given a challenge, prove the key" layer, so the stateful, security-critical orchestration (mint a pending-login token, stash the challenge, refuse a client-supplied user id, only then create a session) lives in one place you can audit, in the next increment.

If you find auth flow logic creeping into this file, that's the smell. Push it back out.

---

## The whole thing, in three beats

    The data model stores the public half and derives "2FA is on" from a row count.
    The library does the dangerous byte-parsing; we orchestrate and pass it our origin + RP.
    We keep the key as text, decode it only to verify, and let the counter stay the library's to judge.
