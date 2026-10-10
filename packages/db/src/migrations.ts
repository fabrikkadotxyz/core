import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './index.ts';

/**
 * Apply every pending migration. Idempotent: already-applied ones are skipped.
 * The server calls this when it starts (M39), so no deployment runs it by hand;
 * `pnpm db:migrate` remains for doing it without starting a server.
 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
}
