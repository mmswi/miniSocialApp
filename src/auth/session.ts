import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { sessions } from '../db/schema.ts';
import { redis } from '../lib/redis.ts';
import { generateToken, hashToken } from './tokens.ts';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
// Short read-through window. Single logout busts its own key instantly; this only bounds how long
// a still-cached session can outlive a `revokeAllUserSessions` (~1 minute) — an accepted tradeoff.
const CACHE_TTL_SECONDS = 60;

type CreatedSession = { rawToken: string; expiresAt: Date };
type ActiveSession = { userId: string; sessionId: string };
type CachedSession = { userId: string; expiresAtMs: number };

const cacheKey = (sessionId: string): string => `session:${sessionId}`;

const revokeBySessionId = async (sessionId: string): Promise<void> => {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
  await redis.del(cacheKey(sessionId));
};

// Issues a fresh session and returns the RAW token for the caller to set as an httpOnly cookie.
// Only the hash is stored, so a DB leak never yields a usable session. Called on login/signup,
// which also gives session-fixation defense for free: every login gets a brand-new id.
export const createSession = async (input: {
  userId: string;
  ip?: string;
  userAgent?: string;
}): Promise<CreatedSession> => {
  const rawToken = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id: hashToken(rawToken),
    userId: input.userId,
    expiresAt,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });
  return { rawToken, expiresAt };
};

// Resolves a raw cookie token to its user, or null if missing/expired. Redis is a read-through
// cache in front of Postgres (the source of truth): a cache miss falls back to the DB and
// repopulates. Expired sessions are deleted as they are encountered.
export const getSessionUser = async (rawToken: string): Promise<ActiveSession | null> => {
  const sessionId = hashToken(rawToken);
  const key = cacheKey(sessionId);

  const cached = await redis.get(key);
  if (cached !== null) {
    const session = JSON.parse(cached) as CachedSession;
    if (session.expiresAtMs <= Date.now()) {
      await revokeBySessionId(sessionId);
      return null;
    }
    return { userId: session.userId, sessionId };
  }

  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (row === undefined) {
    return null;
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    await revokeBySessionId(sessionId);
    return null;
  }

  const secondsUntilExpiry = Math.floor((row.expiresAt.getTime() - Date.now()) / 1000);
  const ttl = Math.min(CACHE_TTL_SECONDS, Math.max(1, secondsUntilExpiry));
  const cacheValue: CachedSession = { userId: row.userId, expiresAtMs: row.expiresAt.getTime() };
  await redis.set(key, JSON.stringify(cacheValue), 'EX', ttl);
  return { userId: row.userId, sessionId };
};

// Single logout — instant: deletes the row and busts the cache key for this exact token.
export const revokeSession = (rawToken: string): Promise<void> =>
  revokeBySessionId(hashToken(rawToken));

// Logout everywhere. Postgres rows go immediately; any still-cached sessions for this user lapse
// within the cache TTL rather than instantly (we don't track every session key per user).
export const revokeAllUserSessions = async (userId: string): Promise<void> => {
  await db.delete(sessions).where(eq(sessions.userId, userId));
};
