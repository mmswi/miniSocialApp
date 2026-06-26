# What a passkey actually is (and why your face never leaves the phone)

> Increment: `feature/auth` — two-factor auth, the concept before the code.
> The implementation lives in the next doc; this one builds the mental model.

Mara already has a password and a login session (that's doc 01 in the parent folder).

Now she wants a second lock on her account. The kind where her phone scans her face.

So here are the scary words, all at once:

    Passkey.

    WebAuthn.

    Relying Party.

    Challenge.

    Attestation.

    Assertion.

And the usual explanation:

> "The authenticator signs a challenge with a private key, and the server verifies it with the public key."

That is not an explanation.

That is a list of things you are now supposed to understand.

So here is the real question underneath all of it:

    How can Mara prove it's really her using her face —
    when her face never leaves her phone,
    and in a way a fake website can't copy and replay?

Let me trace her through it.

---

## First: the naive second factor, and why it's phishable

The obvious way to add a second factor is a shared secret.

A password is a shared secret. A TOTP code — the 6 digits in Google Authenticator — is a shared secret too. The server and the phone both know it, and the phone just shows it to Mara to type in.

This is the naive version:

```
Mara's phone:  secret = 7Q2F...   →  shows code  →  482913
redline server: secret = 7Q2F...   →  expects     →  482913
```

It works. It is also phishable.

A secret only works if it travels. Mara reads the code off her screen and types it into a page.

Now picture a fake site. `red1ine.com`, pixel-perfect. Mara logs in there by mistake. It asks for her code. She types `482913`. The fake site forwards it to the real redline within the 30 seconds it's valid.

The thief is in.

The secret crossed the wire. It crossed Mara's eyes. Anything that travels can be intercepted or relayed.

A passkey never shares a secret at all.

---

## Collapse the definition: a passkey is a key pair

A passkey is two keys that belong together.

A private key. And a public key.

That is all it is.

The private key stays inside the phone's secure hardware. Forever. It never leaves.

The public key is the half you are allowed to hand out.

The trick is what each half can do:

    The private key can SIGN a message.
    The public key can CHECK that signature — but can never produce one.

So Mara's phone can prove it holds the private key by signing something. The server, holding only the public key, can confirm the signature is genuine. But the server — or a thief who steals the server's whole database — can never sign anything as Mara. The public key doesn't let you.

Nothing secret ever travels. Only the public key (safe to share) and signatures (useless to replay, as we'll see).

---

## Your face is not the second factor

You might think the phone scans Mara's face and sends "yes, it's Mara's face" to the server.

It does not.

Her face never leaves the phone.

Face ID is a local lock. It unlocks the private key sitting in the phone's secure chip. That is its only job.

    Face ID  →  unlocks the private key  →  the key signs

The server never sees a face. It never sees the private key. It sees a signature, and checks it against the public key it stored.

Touch ID, a Windows Hello PIN, a YubiKey tap — same shape. A local gate that releases a local key.

---

## The challenge: why a signature can't be replayed

If the phone just signed the word "redline" every time, a thief who captured one signature could resend it forever.

So the server never asks for a signature over something fixed.

It sends a **challenge** — a fresh random number — and asks the phone to sign *that*.

```
server: here is a random challenge → 9f2a7c...e1
phone:  sign(9f2a7c...e1) with the private key → <signature>
server: does <signature> check out against Mara's public key? yes.
```

Next login, a different random challenge. A captured signature is worthless — it answers a question the server will never ask again.

A challenge is a one-time question. The signature is the one-time answer.

---

## Now watch Mara, end to end

Two flows. Enrollment happens once. Authentication happens every login.

**Enrollment — "here is my public key":**

    Mara is logged in. She clicks "add a passkey".
    ↓
    Server sends a challenge + its identity (the RP ID — see below)
    ↓
    Browser asks the phone: make a new key pair for redline
    ↓
    Face ID. The phone generates the pair, keeps the private key in hardware,
    signs the challenge, and hands back: the PUBLIC key + a new credential id
    ↓
    Server verifies, then stores { credentialId, publicKey }

**Authentication — "prove you hold the private key":**

    Mara types email + password. Password is correct.
    ↓  but she has a passkey, so login is NOT done
    Server sends a fresh challenge + the credential ids it has for her
    ↓
    Browser asks the phone to sign the challenge. Face ID unlocks the private key.
    ↓
    Phone returns a signature
    ↓
    Server checks the signature against the stored public key → it's really Mara

The public key did the same job a coat-check ticket did for sessions: the server keeps the half it needs, and the secret half stays with Mara.

---

## RP ID vs origin: the part that kills phishing

Two identifiers trip everyone up. They sound alike. They are not.

**RP ID** — the domain the passkey belongs to. "Relying Party" is just jargon for "the site." Ours is `localhost` in dev, the real host in production.

**Origin** — the exact URL the browser is actually at. `http://localhost:3000`.

Here is the load-bearing rule:

    The browser binds every signature to the origin it is running on.
    And it refuses to use a redline passkey anywhere but redline's origin.

So go back to the fake `red1ine.com`.

Mara's phone has a passkey for redline. The fake site asks for an assertion. The browser checks: this passkey is bound to `localhost` / `redline.app`, and the page is `red1ine.com`. Mismatch. The browser will not even offer the key.

There is no code on screen for Mara to mistype. There is no secret to forward. The one thing that proves her identity is locked to the real origin by the browser itself.

That is why a passkey is phishing-resistant and a typed code is not.

---

## This is a SECOND factor, not passwordless

A passkey *can* be your entire login. No password at all. That's "passwordless," and it's a different design.

We are not doing that here.

Here the password (or Google sign-in) is factor one. The passkey is factor two. Both must pass.

This choice is not cosmetic — it changes the knobs we set when we build the options (we don't ask the phone to store a discoverable login; we hand it the specific credentials to use). The next doc shows exactly where.

---

## The five questions

    Where does it run?      
    Key generation and signing happen on the phone's secure chip.
    Verification happens on the server.
    
    What shape is the data? 
    A challenge (random bytes), a public key (bytes), a signature (bytes), a credential id (a short string).

    What gets stored?       
    The public key + credential id, on the server.
    The private key stays on the device and is never sent.

    What's computed fresh?  
    A new challenge every time. A new signature every time.
    
    What's handed on?       
    "This really is Mara" — to the session step that mints her cookie.

---

## The honest tradeoff, and when not to reach for this

A passkey lives in one device's hardware — or in a synced keychain like iCloud or Google.

Lose the only device that holds it, and that key is gone. There is no "reset my passkey" the way there's a password reset, because the server never had the secret to begin with. That is exactly why we also issue recovery codes (a later doc).

Passkeys also need a real origin. They're perfect on `localhost` for dev, but a credential created for `localhost` will not work on a deployed host — it's bound to the domain it was born on.

When is a passkey the wrong call? If you can't assume a modern browser and OS, or your users won't manage devices, a typed second factor like TOTP is friendlier — at the cost of being phishable. We chose passkeys precisely to learn the phishing-resistant path.

---

## The whole thing, in three beats

    The password proves who you are.
    The passkey proves you hold the device — with a signature your face unlocked but never sent.
    The browser locks that signature to redline, so a fake site has nothing to steal.
