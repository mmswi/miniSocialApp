import type { RateLimitPluginOptions } from '@fastify/rate-limit'
import { AppError } from '../lib/errors.ts'
import { redis } from '../lib/redis.ts'

// Per-endpoint limits (per client IP, per window). Auth endpoints are credential-stuffing and abuse
// targets, so they sit far below a normal API route's allowance. Tune them here.
export const AUTH_RATE_LIMITS = {
  signup: { max: 5, timeWindow: '1 minute' },
  login: { max: 10, timeWindow: '1 minute' },
  verify: { max: 10, timeWindow: '1 minute' },
  google: { max: 10, timeWindow: '1 minute' },
  // forgot is as tight as signup — it triggers an outbound email, so an open one is a spam/probe vector.
  // reset is a touch higher (a user fat-fingering a new password retries) but still bounded against
  // brute-forcing the token, though its 256 bits of entropy already make that hopeless.
  forgotPassword: { max: 5, timeWindow: '1 minute' },
  resetPassword: { max: 10, timeWindow: '1 minute' },
} as const

// Plugin options. The Redis store shares the count across the planned 2 instances — one attacker
// hammering instance A is still counted when the load balancer sends them to instance B. `global:
// false` limits only routes that opt in via config.rateLimit, so /health and /ready stay unthrottled
// for the load balancer. `skipOnError: true` fails OPEN: a Redis hiccup lets traffic through rather
// than locking everyone out of auth, since rate limiting is defense-in-depth, not the primary gate.
export const authRateLimitOptions: RateLimitPluginOptions = {
  global: false,
  redis,
  skipOnError: true,
  // The plugin THROWS whatever this returns, so we hand it an AppError. It then flows through the
  // server's error handler exactly like our other failures and renders as a clean 429 { error,
  // message }. By this point the plugin has already set the x-ratelimit-* / retry-after headers.
  errorResponseBuilder: (_req, context) =>
    new AppError(
      'rate_limited',
      `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
      429,
    ),
}
