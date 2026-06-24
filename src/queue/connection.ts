import { env } from '../lib/env.ts'

// Connection CONFIG (a plain options object), not a live client, for BullMQ to build its connections
// from. Passing config rather than a `new Redis(...)` instance buys two things:
//   1. BullMQ creates and OWNS its connections — one per Queue/Worker, since a blocking worker must not
//      share a connection — and applies the blocking options itself.
//   2. A plain object has no class identity, so BullMQ and the app can run different ioredis copies with
//      no type/`instanceof` clash — no version pin (package.json `overrides`) needed.
// maxRetriesPerRequest is null because BullMQ's worker blocks on a queue read (BRPOPLPUSH) that must
// wait indefinitely. It belongs ONLY here, on BullMQ's connections — the app's shared `redis` client
// keeps ioredis's default so ordinary GET/SET fail fast instead of hanging.
export const queueConnectionConfig = () => {
  const url = new URL(env.REDIS_URL)
  return {
    host: url.hostname,
    port: Number(url.port) || 6379,
    username: url.username === '' ? undefined : url.username,
    password: url.password === '' ? undefined : url.password,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  }
}
