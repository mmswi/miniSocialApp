import { afterAll, describe, expect, test } from 'bun:test'
import { buildServer } from '../server.ts'
import { AUTH_RATE_LIMITS } from './ratelimit.ts'

// Rate limiting is off by default under test (so the other suites aren't throttled); this one opts
// back in. Each test invents a fresh client IP so its Redis counter starts at zero — deterministic,
// and no collision with other runs inside the window. We drive /auth/verify with a bad token: it's a
// clean 400 with no DB side effects, so we can spam it freely and watch the limiter trip.
const app = buildServer({ enableRateLimit: true })

const freshIp = (): string =>
  `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`

afterAll(async () => {
  await app.close()
})

describe('auth rate limiting', () => {
  test('the verify endpoint returns 429 once the per-IP limit is exceeded', async () => {
    const remoteAddress = freshIp()
    const limit = AUTH_RATE_LIMITS.verify.max

    const statuses: number[] = []
    for (let i = 0; i < limit + 1; i++) {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/verify?token=does-not-exist',
        remoteAddress,
      })
      statuses.push(res.statusCode)
    }

    // The first `limit` requests are handled (400 for the bad token); the one past it is throttled.
    expect(statuses.slice(0, limit).every((status) => status === 400)).toBe(true)
    expect(statuses[limit]).toBe(429)
  })

  test('a throttled response carries our error shape', async () => {
    const remoteAddress = freshIp()
    const limit = AUTH_RATE_LIMITS.verify.max

    let last: Awaited<ReturnType<typeof app.inject>> | undefined
    for (let i = 0; i < limit + 1; i++) {
      last = await app.inject({ method: 'GET', url: '/auth/verify?token=x', remoteAddress })
    }

    expect(last?.statusCode).toBe(429)
    expect(last?.json<{ error: string }>().error).toBe('rate_limited')
  })

  test('a nested /auth/2fa route is rate-limited too — the limit binds on the grandchild plugin', async () => {
    // The 2FA routes live in a plugin nested under authRoutes (itself under /auth), so the limiter has
    // to reach a grandchild. With no mfa cookie each handled request is a 401; the limiter's onRequest
    // hook trips before the handler on the one past the limit, proving config.rateLimit is applied here.
    const remoteAddress = freshIp()
    const limit = AUTH_RATE_LIMITS.twoFactorRecovery.max

    const statuses: number[] = []
    for (let i = 0; i < limit + 1; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/2fa/recovery/verify',
        payload: { code: 'x' },
        remoteAddress,
      })
      statuses.push(res.statusCode)
    }

    expect(statuses.slice(0, limit).every((status) => status === 401)).toBe(true)
    expect(statuses[limit]).toBe(429)
  })

  test('a separate IP is unaffected by another IP hitting its limit', async () => {
    const limit = AUTH_RATE_LIMITS.verify.max
    const attacker = freshIp()
    for (let i = 0; i < limit + 1; i++) {
      await app.inject({ method: 'GET', url: '/auth/verify?token=x', remoteAddress: attacker })
    }

    // A different client is on its own counter, so its first request still goes through.
    const bystander = await app.inject({
      method: 'GET',
      url: '/auth/verify?token=x',
      remoteAddress: freshIp(),
    })
    expect(bystander.statusCode).toBe(400)
  })
})
