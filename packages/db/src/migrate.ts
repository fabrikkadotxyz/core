import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createClient } from './index.ts';

const { sql, db } = createClient();

await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
console.log('migrations applied');

await sql.end();
