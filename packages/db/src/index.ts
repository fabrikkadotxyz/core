import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

export * from './schema.ts';
export { schema };

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env — see README.md.',
    );
  }
  return url;
}

/**
 * Postgres NOTICEs that are expected and carry no information.
 * 42P06/42P07: "already exists, skipping" from the migrator's IF NOT EXISTS.
 */
const BENIGN_NOTICES = new Set(['42P06', '42P07']);

export function createClient() {
  const sql = postgres(databaseUrl(), {
    max: 10,
    onnotice(notice) {
      // Notices print like errors and make a clean migration look broken.
      // Swallow only the ones we expect; surface anything else.
      if (notice.code && BENIGN_NOTICES.has(notice.code)) return;
      console.warn(`[postgres] ${notice.severity}: ${notice.message}`);
    },
  });
  return { sql, db: drizzle(sql, { schema }) };
}

export type Database = ReturnType<typeof createClient>['db'];

export * from './auth.ts';
