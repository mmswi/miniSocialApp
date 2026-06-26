import { Redis } from 'ioredis'
import { env } from './env.ts'

type RedisGlobal = { redis?: Redis }
const globalForRedis = globalThis as unknown as RedisGlobal

// One Redis connection per process, cached on globalThis so dev hot-reload and repeated imports
// reuse it instead of leaking a new connection each time. `lazyConnect` keeps the import cheap —
// no socket opens until the first command.
export const redis: Redis = globalForRedis.redis ?? new Redis(env.REDIS_URL, { lazyConnect: true })

if (env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis
}
