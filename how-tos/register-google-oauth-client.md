# How-to: Register the Google OAuth client (local dev)

Wires up "Continue with Google" by creating OAuth credentials in Google Cloud Console and
dropping them into `.env`.

**The one rule:** the redirect URI must be **exactly** `http://localhost:3000/auth/google/callback`
— port **3000** (the web/Vite origin the browser sees, not the API's 3001), `http` not `https`,
no trailing slash. Google rejects anything that isn't a character-for-character match.

Scopes the app requests: `openid`, `email`, `profile` — all non-sensitive, so no Google
verification review is needed for dev.

## Steps

1. **Project** — [console.cloud.google.com](https://console.cloud.google.com) → create or pick a
   project (e.g. `redline-dev`).

2. **OAuth consent screen** (APIs & Services → OAuth consent screen):
   - User type: **External** → Create
   - App name: `redline` · User support email: your email · Developer contact: your email
   - Scopes: leave defaults (`openid`/`email`/`profile` are added automatically)
   - **Test users: add your own Google email.** While the app is in "Testing" status, only listed
     test users can sign in — otherwise you hit *"Access blocked: app not verified."*

3. **Create OAuth client** (APIs & Services → Credentials → Create Credentials → OAuth client ID):
   - Application type: **Web application**
   - Name: `redline local`
   - Authorized JavaScript origins: `http://localhost:3000`
   - Authorized redirect URIs: `http://localhost:3000/auth/google/callback`
   - Create → copy the **Client ID** and **Client Secret**.

4. **Put the credentials in `.env`** (redirect URI is already correct; only ID/secret are blank):
   ```
   GOOGLE_CLIENT_ID=<paste client id>
   GOOGLE_CLIENT_SECRET=<paste client secret>
   GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
   ```

5. **Restart the API** — env is parsed once at boot (`src/lib/env.ts`), so stop and restart
   `bun run api`.

6. **Test** — open `http://localhost:3000`, click **Continue with Google**. It should bounce to
   Google's consent screen and back to `/auth/google/callback`.

## Gotchas

- **Port 3000, not 3001.** The button hits `/auth/google`, the Vite proxy forwards `/auth` → :3001,
  and Google redirects the *browser* back to `http://localhost:3000/auth/google/callback`. So 3000
  is correct everywhere Google is concerned.
- **Redirect URI is an exact match.** Scheme, host, port, and path must match `.env`'s
  `GOOGLE_REDIRECT_URI` exactly. A trailing slash or `https` will fail.
- **Test user not added** → "Access blocked: app not verified." Add your email under Test users.
