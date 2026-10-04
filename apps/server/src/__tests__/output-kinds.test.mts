/**
 * ADR 0023: an output kind is a plug-in module. Nothing outside a kind's own
 * folders and the two registries may name a kind.
 *
 * Decoupling that is not checked erodes one convenient `if (kind === …)` at a
 * time — which is how M13 ended up with `latex` in eight files. This test is the
 * boundary: it reads the registered kind ids from the server's `kinds/` folders
 * and fails if any of them appears as a string literal anywhere else in the apps
 * or the shared types.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { KINDS } from '../outputs/registry.ts';

let fails = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('ok  ', label);
  else { console.error('FAIL', label, '\n  got ', g, '\n  want', w); fails++; }
};

const ROOT = resolve(import.meta.dirname, '../../../..');
const SERVER_KINDS = join(ROOT, 'apps/server/src/outputs/kinds');
const WEB_KINDS = join(ROOT, 'apps/web/src/outputs/kinds');

/* ------------------------------------------------- the registry matches disk */

const folders = readdirSync(SERVER_KINDS).filter((d) => statSync(join(SERVER_KINDS, d)).isDirectory()).sort();
const registered = KINDS.map((k) => k.id).sort();
eq('every server kind folder is registered, and every registered kind has a folder', registered, folders);
eq('kind ids are unique', new Set(registered).size, registered.length);
for (const k of KINDS) {
  eq(`${k.id}: its main file is in its template`, k.mainFile in k.template('x'), true);
  eq(`${k.id}: a multi-file kind says which files it accepts`, !k.multiFile || !!k.files, true);
}

/* ------------------------------------------------- no kind named outside it */

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx|mts)$/.test(name)) yield path;
  }
}

const allowed = (path: string) =>
  path.startsWith(SERVER_KINDS + '/') ||
  path.startsWith(WEB_KINDS + '/') ||
  path.endsWith('apps/server/src/outputs/registry.ts') ||
  // Built-in templates (M25) are data that name a kind the way a stored output
  // row does — "start with a doc called Pitch". No code there branches on a kind.
  path.startsWith(join(ROOT, 'apps/server/src/templates/builtin') + '/');

const literal = new RegExp(`(['"\`])(${registered.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\1`);

const leaks: string[] = [];
for (const dir of ['apps/server/src', 'apps/web/src', 'packages/types/src']) {
  for (const file of sources(join(ROOT, dir))) {
    if (allowed(file)) continue;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        // Comments may mention a kind by name; code may not.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        const m = literal.exec(code);
        if (m) leaks.push(`${relative(ROOT, file)}:${i + 1}  ${m[0]}`);
      });
  }
}
eq('no file outside outputs/kinds/ and the registries names a kind', leaks, []);

if (fails) {
  console.error(`\n${fails} failure(s)`);
  process.exit(1);
}
