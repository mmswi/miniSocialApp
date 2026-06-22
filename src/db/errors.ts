// Postgres reports a UNIQUE constraint violation as SQLSTATE 23505. Catching it lets the database be
// the race-safe arbiter of "already exists" — the first insert wins, the loser gets this — instead of
// a check-then-insert that two concurrent requests can both pass.
export const isUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const { code } = error as { code?: unknown }
  return code === '23505'
}
