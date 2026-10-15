/**
 * M49 acceptance: the output in its own tab (ADR 0045).
 *
 * The page is UI (the manual test), but the contract under it is checkable:
 *   - the output's address serves the app, signed in or not (the app signs in);
 *   - the desktop command exists, is in the app's command manifest, and is
 *     granted to the instance's origin, with the path rule beside it;
 *   - the web app asks for it by that name.
 *
 * Requires: server on :9090.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'http://localhost:9090';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
const check = (cond, m) => (cond ? console.log('ok  ', m) : (console.error('FAIL', m), failures++));

const res = await fetch(`${ORIGIN}/o/someone/s/some-room/output`);
const html = await res.text();
check(res.status === 200 && /text\/html/.test(res.headers.get('content-type') ?? '') && /<div id="root">/.test(html), 'the output address serves the app');

const rust = readFileSync(join(root, 'apps/desktop/src-tauri/src/main.rs'), 'utf8');
const manifest = readFileSync(join(root, 'apps/desktop/src-tauri/build.rs'), 'utf8');
const web = readFileSync(join(root, 'apps/web/src/desktop.ts'), 'utf8');
check(/#\[tauri::command\]\s*\nfn open_output\(/.test(rust), 'the desktop app has the open_output command');
check(/"open_output"/.test(manifest), '…listed in the app manifest, so it needs an explicit permission');
check(/permission\("allow-open-output"\)/.test(rust) && /\.remote\(format!\("\{origin\}\/\*"\)\)/.test(rust), "…granted to the instance's origin only");
check(/fn is_output_path/.test(rust) && /is_output_path\(path\)/.test(rust), '…and only for a path shaped like an output');
check(/invoke\('open_output', \{ path \}\)/.test(web), 'the web app asks for it by that name');

if (failures) {
  console.error(`\n${failures} M49 check(s) failed`);
  process.exit(1);
}
console.log('\nM49 checks passed');
