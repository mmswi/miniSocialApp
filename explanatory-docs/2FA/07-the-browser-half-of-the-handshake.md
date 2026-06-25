# The browser's half of the handshake (logging in with a passkey)

> Increment: `feature/auth` — 2FA, the login frontend.
> Files: `web/src/pages/TwoFactorPage.tsx`, `web/src/pages/LoginPage.tsx`, `web/src/lib/api.ts`.

Everything so far has been the server. Now the part Mara actually touches.

She types her password. A passkey prompt appears. She looks at her phone. She's in.

Three button-presses of UI, sitting on top of all that backend. This doc is what happens between them.

---

## The fork that sends her to /2fa

Login used to be one outcome: a session. Now the API can answer two ways, and the type says so:

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

Notice what the client does *not* receive on the `mfaRequired` branch: no token, no userId, nothing. The pending-MFA cookie was set by the server, httpOnly, invisible to JavaScript. The browser just knows "go to /2fa" and the cookie rides along automatically on the next request.

---

## The three-step dance the page runs

On `/2fa`, Mara taps "Verify with passkey." That kicks off a handshake the page orchestrates in three moves:

```
  1. ask the server for options   →  API_2faAuthenticateOptions()      (network)
  2. hand them to the browser     →  startAuthentication({ optionsJSON })  (device — Face ID)
  3. send the signed result back  →  API_2faAuthenticateVerify(assertion)   (network)
```

In code:

```ts
// web/src/pages/TwoFactorPage.tsx
const options = await API_2faAuthenticateOptions()
const assertion = await startAuthentication({ optionsJSON: options })
await API_2faAuthenticateVerify(assertion)
await finishLogin()
```

Step 2 is the only line that isn't a network call. `startAuthentication` is from `@simplewebauthn/browser`, and it's the wrapper around `navigator.credentials.get()` — the thing that actually makes the OS show the Face ID sheet, unlock the private key, and sign the server's challenge.

That's why the device step lives in the *page*, not in `api.ts`. The `API_` functions are network calls and nothing else; the browser ceremony is a different kind of operation, so it sits where the user gesture is.

---

## Why a button, not an auto-run

The page could fire `startAuthentication` the moment it loads. It doesn't.

Browsers gate the WebAuthn prompt behind a user gesture — a real click — partly so a page can't silently pop a credential request the instant you land on it. Auto-running it on mount is the kind of thing browsers increasingly refuse.

So `/2fa` shows a button, and the handshake starts when Mara presses it. The gesture is both a browser requirement and the honest UX: she chose to authenticate.

---

## When the phone is in the lake

Mara might not have her passkey. Lost phone, wiped laptop. So the page has a second door:

```ts
const verifyWithRecoveryCode = async (event) => {
  event.preventDefault()
  await API_2faRecoveryVerify(recoveryCode)
  await finishLogin()
}
```

"Use a recovery code instead" swaps the passkey button for a text field. One of the codes from doc 04 goes to the same finish line — a session — minus the device. No challenge, no browser ceremony, just the code.

Both paths end in `finishLogin`, which does the one thing the client *can* do once the cookie is set: re-ask the server who it is.

```ts
const finishLogin = async () => {
  await refresh()   // GET /auth/me — the server is the source of truth
  navigate('/')
}
```

The session cookie is httpOnly, remember — the client can't read it to know "am I logged in now?" So it asks. `refresh()` pulls `/auth/me`, the auth context flips to authenticated, and Mara lands on the dashboard.

---

## Two failure families, one message

A passkey login can fail two very different ways, and the page flattens them into one human sentence:

```ts
const toMessage = (caught: unknown): string => {
  if (caught instanceof ApiError) {
    return caught.message            // the server said no: expired pending login, rejected assertion
  }
  if (caught instanceof WebAuthnError) {
    return "Couldn't read your passkey. Try again, or use a recovery code."  // the prompt itself failed
  }
  return 'Something went wrong. Please try again.'
}
```

The `WebAuthnError` is the telling one. It fires when the *browser* ceremony breaks — Mara hit cancel, the sensor timed out, there's no matching credential on this device. That never reached the server, so there's no server message to show; the page supplies its own, and points her at the recovery-code escape hatch.

---

## The five questions

    Where does it run?
    The page orchestrates in the browser; step 2 (startAuthentication) runs on the device; steps 1 and
    3 hit the server.

    What shape is the data?
    Option JSON down, a signed assertion (also JSON) back up. The pending-MFA cookie rides invisibly.

    What gets stored?
    Nothing new on the client — the cookie is the server's. On success the session cookie replaces the
    pending one, both httpOnly.

    What's computed fresh?
    A signature on the device per attempt; a /auth/me re-fetch after success to learn the new state.

    What's handed on?
    A verified assertion (or a recovery code) to the server, which mints the session the client then
    discovers via /auth/me.

---

## When the client should stay dumb

It's tempting to make the frontend smarter — cache the user, decode something, track "2FA pending" in React state. Resist it.

The client holds no secret and no authority here. It can't read the httpOnly cookies, it can't verify a passkey, it can't decide who's logged in. Its whole job is: route to the right screen, trigger the device prompt on a click, and ask the server what's true afterward. Every time the frontend is tempted to *know* something about auth, the right move is to ask `/auth/me` instead. A dumb client is the secure client.

---

## The whole thing, in three beats

    The API answers login two ways; { mfaRequired } sends Mara to /2fa with an invisible cookie.
    The page runs options → device → verify, and the browser's Face ID sheet is the only non-network step.
    Either factor ends at /auth/me, because the httpOnly session is the server's to know and the client's to ask about.
