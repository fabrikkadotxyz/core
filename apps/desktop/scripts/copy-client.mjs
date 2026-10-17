/**
 * Put the client the app runs (M34, ADR 0031) into the app's resources: the
 * exact file this repository's instance serves at /downloads/fabrikka.mjs, so
 * the app and the installer can't run different clients.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const from = fileURLToPath(new URL('../../../packages/bridge/dist/cli.js', import.meta.url));
const dir = fileURLToPath(new URL('../src-tauri/resources/', import.meta.url));
const to = `${dir}fabrikka.mjs`;
if (!existsSync(from)) {
  console.error('no client build: run `pnpm --filter @fabrikka/bridge build` first');
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
copyFileSync(from, to);
console.log(`client → ${to}`);
