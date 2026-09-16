// The invite token travels as a URL query param across the ENTIRE accept-through-login detour (invite →
// login/signup → 2fa → back to invite), so its name is fixed in exactly one place here. A stray
// 'inviteToken' typo in any page that passes it would silently break the hand-off with no error.
//
// This MUST match the param the backend puts in the emailed link — `?inviteToken=` in
// `src/teams/invites.ts` (the `inviteLink` builder). The two live on opposite sides of the src/ ↔ web/
// boundary and can't share a constant (that would drag server code into the browser bundle), so a rename
// on either side has to be mirrored by hand on the other. A comment on the backend side points back here.
export const INVITE_TOKEN_PARAM = 'inviteToken'

// The invite token off a location's query string, or null when there isn't one.
export const readInviteToken = (search: string): string | null =>
  new URLSearchParams(search).get(INVITE_TOKEN_PARAM)

// A path with the invite token carried along as a query param — used to send the visitor to /login,
// /signup, and /2fa without dropping the invite, and back to /invite once they're authenticated. Returns
// the bare base untouched when there's no token, so a normal (non-invite) navigation is unaffected.
export const withInviteToken = (base: string, token: string | null): string =>
  token === null ? base : `${base}?${INVITE_TOKEN_PARAM}=${encodeURIComponent(token)}`
