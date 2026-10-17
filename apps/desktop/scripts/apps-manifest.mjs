/**
 * Write dist-app/apps.json (ADR 0056) from every <file>.meta.json in a folder:
 * the list the server serves and the installers read. Run by `package` for the
 * platform it just built, and by the release workflow over all four.
 *   node scripts/apps-manifest.mjs [folder]   (default: dist-app)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'dist-app');
const apps = readdirSync(dir)
  .filter((f) => f.endsWith('.meta.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  .sort((a, b) => a.platform.localeCompare(b.platform));
const version = apps[0]?.version ?? 'dev';
writeFileSync(join(dir, 'apps.json'), JSON.stringify({ version, apps: apps.map(({ platform, file, sha256, size }) => ({ platform, file, sha256, size })) }, null, 2) + '\n');
console.log(`apps.json: ${apps.map((a) => a.platform).join(', ') || 'no apps'}`);
