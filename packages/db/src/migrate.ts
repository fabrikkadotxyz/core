import { createClient } from './index.ts';
import { runMigrations } from './migrations.ts';

const { sql, db } = createClient();

await runMigrations(db);
console.log('migrations applied');

await sql.end();
