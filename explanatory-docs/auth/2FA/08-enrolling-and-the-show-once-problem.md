# Enrolling a passkey, and the show-once problem

> Increment: `feature/auth` — 2FA, the Security page.
> Files: `web/src/pages/SecurityPage.tsx`, `web/src/lib/api.ts`.

Doc 07 was logging in. This is the other side: Mara turning 2FA *on*, living with it, and turning it off.

One screen, `/security`, does all of it. And it has one genuinely tricky moment — a secret the server will hand over exactly once.

---

## Enrolling: the browser makes a key

Logging in *used* a passkey. Enrolling *creates* one. Same three-step shape, different verb in the middle:

```ts
// web/src/pages/SecurityPage.tsx
const options = await API_2faRegisterOptions()
const response = await startRegistration({ optionsJSON: options })  // Face ID — makes a NEW key pair
const result = await API_2faRegisterVerify({ response, name })
```

`startRegistration` is the create-time twin of `startAuthentication`. It wraps `navigator.credentials.create()`: the OS prompts for Face ID, the device generates a fresh key pair in its secure hardware, and hands back the *public* key. The private key never even leaves the chip to be seen.

The server verifies and stores the public key (doc 02). Mara now has a passkey.

---

## The show-once problem

Here's the moment that needs care.

When Mara enrolls her *first* passkey, the server turns 2FA on and mints ten recovery codes. It returns them in the verify response — and never again:

```ts
const result = await API_2faRegisterVerify({ response, name })
if (result.recoveryCodes !== undefined) {
  setNewCodes(result.recoveryCodes)   // present them NOW; there is no second chance
}
```

Why only once? Because the server stores codes the same way it stores everything sensitive: hashed (doc 04). It cannot show them again because it threw the originals away on purpose. There is no "resend my codes" endpoint, because there is nothing to resend.

So the UI has a duty the rest of the page doesn't: it must make Mara *stop and save them*.

```tsx
{newCodes !== null ? (
  <div className="...amber warning box...">
    <p>Save your recovery codes. This is the only time they're shown.</p>
    <ul>{newCodes.map((code) => <li key={code}>{code}</li>)}</ul>
    <button onClick={() => setNewCodes(null)}>I've saved them</button>
  </div>
) : null}
```

The codes live in component state, shown in a loud box, dismissed only by an explicit "I've saved them." If Mara reloads the page, they're gone — exactly as they should be. The whole design leans on this: the one place the raw codes ever exist on the client is this transient state, for this one render.

This is the rare case where the frontend holds something the server doesn't. Doc 07 said "a dumb client is the secure client" — here the client is briefly the *only* holder of the plaintext, so its one job is to hand it to the human and forget it.

---

## Managing: list, rename, remove

Once 2FA is on, the page shows what the server reports — a safe projection, no key material (doc 06):

```ts
const { credentials, recoveryCodesRemaining } = await API_2faListCredentials()
```

Rename and remove are ordinary calls. The interesting one is remove, because the server can say no:

```ts
const removePasskey = (id: string) =>
  run(async () => {
    await API_2faDeleteCredential(id)   // throws ApiError 'last_passkey' if this is the only one
    await load()
  })
```

If Mara tries to remove her last passkey, the server returns 409 `last_passkey` (doc 06), the `run` wrapper catches it, and `toMessage` surfaces the server's own sentence: *"This is your last passkey. Disable 2FA to remove it."* The client doesn't need to re-implement that rule — it just trusts the server and shows the message. The rule lives in one place.

---

## Disabling: the client side of step-up

Turning 2FA off is the dangerous action (doc 06), so the page can't just call an endpoint — it has to *prove a fresh factor*. It offers both ways:

```ts
// confirm with a passkey: step-up options → device → disable
const disableWithPasskey = () => run(async () => {
  const options = await API_2faStepUpOptions()
  const assertion = await startAuthentication({ optionsJSON: options })
  await API_2faDisable({ assertion })
  await load()
})

// or a recovery code, no device needed
const disableWithRecovery = (event) => { event.preventDefault(); return run(async () => {
  await API_2faDisable({ recoveryCode: recoveryInput.trim() })
  await load()
}) }
```

It's the login handshake again — `stepup/options → startAuthentication → disable` — pointed at a destructive action instead of a session. The server is the one enforcing that a session alone isn't enough; the page just collects the fresh factor and passes it along. On success, `load()` re-reads the (now empty) list, and the page flips back to "Off."

---

## One busy/error envelope for every action

Add, remove, rename, disable — they all run through one wrapper:

```ts
const run = async (action: () => Promise<void>) => {
  setError(null)
  setBusy(true)
  try { await action() }
  catch (caught) { setError(toMessage(caught)) }
  finally { setBusy(false) }
}
```

One `busy` flag disables every button while any call is in flight (no double-submits), and one `error` slot means every failure — a rejected passkey, a 409, a dismissed prompt — surfaces in the same place with the same `ApiError` / `WebAuthnError` / generic mapping from doc 07. The page has many actions but one way to be busy and one way to fail.

---

## The five questions

    Where does it run?
    The page orchestrates; startRegistration/startAuthentication run on the device; the rest hits the server.

    What shape is the data?
    Option JSON out, an attestation/assertion back; a safe passkey list in; recovery codes once, in state.

    What gets stored?
    Server-side: the new public key, and (first enroll) hashed recovery codes. Client-side: nothing
    durable — the plaintext codes live only in transient state until "I've saved them."

    What's computed fresh?
    A key pair on enroll; a fresh-factor proof on disable; a list re-fetch after every change.

    What's handed on?
    To the server: a new credential, a rename/delete, or a disable proof. To the human: ten codes, once.

---

## When the UI is the last line of defense

Almost everywhere in this system, losing a client-side value is harmless — the server is the truth, just ask again. The recovery codes are the one exception. If the page fails to make Mara save them, nothing else can recover them; they're gone the moment she navigates away.

So this is the one screen where UX *is* security. The loud box, the explicit acknowledge, the refusal to tuck the codes behind a reload — those aren't polish, they're the safeguard. Get the show-once moment wrong and you've built a 2FA that quietly locks people out the first time they lose a phone. Everywhere else the client can be dumb; here it has to be insistent.

---

## The whole thing, in three beats

    Enrolling makes a key on the device; the server keeps the public half and, the first time, ten codes.
    Those codes are shown exactly once, in transient state, behind an explicit "I've saved them."
    Managing trusts the server's rules, and disabling re-proves a fresh factor before the off switch turns.
