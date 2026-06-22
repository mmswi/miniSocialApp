import { createHash, randomBytes } from 'node:crypto';

// 32 bytes = 256 bits of entropy, base64url so the value rides safely in cookies and links.
// This is the RAW token — it goes to the user (cookie / verification link) and is never stored.
export const generateToken = (): string => randomBytes(32).toString('base64url');

// We persist only this hash. A database leak then exposes no usable token. sha256 (not a slow
// password hash) is right: the token is already high-entropy, so there is nothing to brute-force.
export const hashToken = (rawToken: string): string =>
  createHash('sha256').update(rawToken).digest('hex');
