import { afterAll } from 'bun:test'
import { closeDb } from '../src/db/client.ts'
import { redis } from '../src/lib/redis.ts'

// bun runs every *.test.ts in ONE shared process, and a preload's top-level afterAll fires exactly
// once after the whole suite. So this is the single correct place to close the globalThis-cached
// Postgres pool and Redis connection — closing them per-file would tear down singletons that other
// still-running test files depend on.
afterAll(async () => {
  // A run that never touched Redis (e.g. only the pure-crypto tests) leaves the lazy client in
  // 'wait'; quit() there would try to connect just to disconnect, so drop it instead.
  if (redis.status === 'wait') {
    redis.disconnect()
  } else {
    await redis.quit()
  }
  await closeDb()
})
