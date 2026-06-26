import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { authRateLimitOptions } from './auth/ratelimit.ts'
import { authRoutes } from './auth/routes.ts'
import { db } from './db/client.ts'
import { env } from './lib/env.ts'
import { AppError } from './lib/errors.ts'
import { redis } from './lib/redis.ts'
import { createEmailWorker } from './queue/email-worker.ts'

type BuildServerOptions = { enableRateLimit?: boolean }

// Uses the process-wide singletons (db, redis, env) directly — the server is the one place that
// wires the app together, so there is nothing to inject.
export const buildServer = (options: BuildServerOptions = {}): FastifyInstance => {
  // Off by default under test so the functional suites (many requests from one IP) aren't throttled;
  // the dedicated ratelimit test opts back in. On everywhere else.
  const enableRateLimit = options.enableRateLimit ?? env.NODE_ENV !== 'test'
  // trustProxy resolves req.ip from X-Forwarded-For, but only for the configured proxy hop (set via
  // env in prod); empty in dev means req.ip is the raw socket address. Per-IP rate limiting is only
  // correct when req.ip is the real client, so this and the limiter are deliberately coupled.
  const app = Fastify({
    logger: true,
    trustProxy: env.TRUST_PROXY === '' ? false : env.TRUST_PROXY,
  })
  app.register(cookie, { secret: env.COOKIE_SECRET })

  // Registered before the routes so each auth route's `config.rateLimit` is applied. The plugin is
  // fastify-plugin-wrapped, so this single registration also covers the routes in the /auth child.
  if (enableRateLimit) {
    app.register(rateLimit, authRateLimitOptions)
  }

  // Our deliberate AppErrors become clean responses; anything else is an unexpected bug, so we
  // log it and return a generic 500 — internals never reach the client.
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message })
    }
    app.log.error({ err: error }, 'unhandled error')
    return reply.code(500).send({ error: 'internal_error', message: 'Something went wrong' })
  })

  // Liveness: the process is up. No dependency checks — the platform uses this to decide whether
  // to restart the container.
  app.get('/health', () => ({ status: 'ok' }))

  // Readiness: dependencies are reachable. The load balancer uses this to decide whether to route
  // traffic, so it must actually touch Postgres and Redis.
  app.get('/ready', async (_req, reply) => {
    try {
      await db.execute(sql`select 1`)
      await redis.ping()
      return { status: 'ready' }
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'unknown'
      app.log.error({ err: error }, 'readiness check failed')
      return reply.code(503).send({ status: 'not_ready', reason })
    }
  })

  // Auth endpoints live under /auth — signup, login, logout, and the session check (/me).
  app.register(authRoutes, { prefix: '/auth' })

  return app
}

const startFromCli = async (): Promise<void> => {
  const app = buildServer()
  try {
    const address = await app.listen({ port: env.PORT, host: '0.0.0.0' })
    app.log.info(`listening on ${address}`)
    // Dev convenience: co-locate the queue worker so a single `bun run api` still delivers email end to
    // end (no second terminal to remember). Production runs the worker as its OWN process
    // (`bun run src/worker.ts`) — there, a slow mail provider must never tie up an API container. Same
    // worker module either way. `bun run api` uses --watch, which RESTARTS the process on change, so the
    // worker is recreated fresh each time, not leaked.
    if (env.NODE_ENV === 'development') {
      createEmailWorker()
      app.log.info('email worker started in-process (dev only)')
    }
  } catch (error: unknown) {
    app.log.error({ err: error }, 'failed to start')
    process.exit(1)
  }
}

// Only run when this file is executed directly (`bun run src/server.ts`), never on import —
// so importing `buildServer` in a test stays side-effect free.
if (import.meta.main) {
  void startFromCli()
}
