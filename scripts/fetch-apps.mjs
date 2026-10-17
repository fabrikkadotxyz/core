/**
 * Fetch a release's desktop apps into a folder the server serves (ADR 0056):
 *   node scripts/fetch-apps.mjs <base url> [folder]
 * reads <base url>/apps.json and every file it names, refusing any whose
 * SHA-256 differs. Used by docker/Dockerfile with FABRIKKA_APPS_URL.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const [base, folder = 'apps/desktop/dist-app'] = process.argv.slice(2);
if (!base) {
  console.error('usage: fetch-apps.mjs <base url> [folder]');
  process.exit(2);
}
const dir = resolve(folder);
mkdirSync(dir, { recursive: true });
const get = async (name) => {
  const res = await fetch(`${base.replace(/\/$/, '')}/${name}`, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};
const index = JSON.parse((await get('apps.json')).toString('utf8'));
for (const app of index.apps ?? []) {
  if (basename(app.file) !== app.file || !/^[0-9a-f]{64}$/.test(app.sha256)) throw new Error(`refusing entry ${JSON.stringify(app)}`);
  const bytes = await get(app.file);
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== app.sha256) throw new Error(`${app.file}: checksum mismatch, refusing it`);
  writeFileSync(join(dir, app.file), bytes);
  writeFileSync(join(dir, `${app.file}.sha256`), `${sha}  ${app.file}\n`);
  console.log(`${app.platform}: ${app.file} (${(bytes.length / 1e6).toFixed(1)} MB)`);
}
writeFileSync(join(dir, 'apps.json'), JSON.stringify(index, null, 2) + '\n');
