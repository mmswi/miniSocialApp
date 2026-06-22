import { hash, verify } from '@node-rs/argon2'

// OWASP-recommended argon2id settings (memory-hard). Bump `memoryCost` as production hardware
// allows; changing these later is safe because every hash stores its own parameters.
const ARGON2_OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const

export const hashPassword = (plainPassword: string): Promise<string> =>
  hash(plainPassword, ARGON2_OPTIONS)

// argon2's verify is constant-time and reads the parameters from the stored hash. Returns false on
// mismatch instead of throwing, so callers branch on a boolean.
export const isPasswordCorrect = (storedHash: string, plainPassword: string): Promise<boolean> =>
  verify(storedHash, plainPassword)
