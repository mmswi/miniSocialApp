import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  COOKIE_SECRET: z.string().min(16),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  APP_URL: z.string().url().default('http://localhost:3000'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z.string().url().default('http://localhost:3000/auth/google/callback'),
  EMAIL_FROM: z.string().default('noreply@localhost'),
});

export type Env = z.infer<typeof envSchema>;

// Parse explicitly — handy in tests that want to feed a custom source. Throws with field-level
// detail if a required var is missing or malformed, so failures surface loudly, not at first use.
export const loadEnv = (source: Record<string, string | undefined> = process.env): Env =>
  envSchema.parse(source);

// The process-wide config singleton. Pure data (no connection), so it needs no globalThis guard —
// just parse once at import. A missing/invalid var throws here, failing the process at boot.
export const env: Env = loadEnv();
