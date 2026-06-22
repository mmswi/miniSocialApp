import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../lib/env.ts';
import * as schema from './schema.ts';

export type Db = PostgresJsDatabase<typeof schema>;

type DbGlobal = { db?: Db };
const globalForDb = globalThis as unknown as DbGlobal;

// One postgres-js pool per process, cached on globalThis (hot-reload safe). The pool connects
// lazily on the first query, so importing this file opens nothing.
export const db: Db = globalForDb.db ?? drizzle(postgres(env.DATABASE_URL), { schema });

if (env.NODE_ENV !== 'production') {
  globalForDb.db = db;
}
