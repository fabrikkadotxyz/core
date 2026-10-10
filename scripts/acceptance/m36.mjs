/**
 * M36 acceptance: a selector worthy of the app, and a resizable sidebar.
 *
 * What can be checked without a person or a browser, from the source:
 *   - no native <select> is left in the web app, the Folders window or the
 *     terminal host's page;
 *   - the app's selector implements the listbox pattern and its keyboard;
 *   - folder policies are a segmented radio group in both the Folders window
 *     and the terminal host's page, with Full's warning;
 *   - the sidebar's width clamps to 200–420, starts at 248, is remembered, and
 *     its edge is a focusable separator that ← → move.
 * How it looks and feels (light and dark, the desktop app) stays the manual test.
 *
 * Requires: nothing running. Reads files only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const read = (p) => readFileSync(p, 'utf8');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
/** Source without its comments, so a comment that mentions <select> doesn't count. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/<!--[\s\S]*?-->/g, '');

/* ------------------------------------------------ 1. no native selects */

const webFiles = walk('apps/web/src').filter((p) => /\.(tsx?|html)$/.test(p));
const nativeIn = (p) => /<select[\s>]/.test(code(read(p)));
const leftovers = [...webFiles, 'apps/desktop/src/folders.html', 'packages/bridge/src/host/control.ts'].filter(nativeIn);
check(leftovers.length === 0, `no native <select> in the web app, the Folders window or the host page${leftovers.length ? `: ${leftovers.join(', ')}` : ''}`);

/* ------------------------------------------------ 2. the selector: listbox pattern and keyboard */

const select = read('apps/web/src/components/Select.tsx');
check(/aria-haspopup="listbox"/.test(select) && /aria-expanded=\{/.test(select), 'the button says it opens a listbox, and whether it is open');
check(/role="listbox"/.test(select) && /role="option"/.test(select), 'the list is a listbox of options');
check(/aria-activedescendant=/.test(select) && /aria-selected=/.test(select), 'the active and the chosen option are announced (aria-activedescendant, aria-selected)');
check(['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', "' '", 'Escape'].every((k) => select.includes(k)), 'keyboard: ↑ ↓ Home End move, Enter or Space chooses, Escape closes');
check(/addEventListener\('pointerdown'/.test(select), 'an outside click closes it');
check(/setUpward\(/.test(select) && /select-list\$\{upward \? ' up'/.test(select), 'it opens upward when there is no room below');

/* ------------------------------------------------ 3. folder policies: a segmented control */

for (const [where, path] of [
  ['the Folders window', 'apps/desktop/src/folders.html'],
  ["the terminal host's page", 'packages/bridge/src/host/control.ts'],
]) {
  const src = read(path);
  check(/role="radiogroup"/.test(src) && /role="radio"/.test(src) && /aria-checked=/.test(src), `${where}: the policy is one radio group, all choices visible`);
  check(/Edit in folder/.test(src) && /Read only/.test(src) && /Full/.test(src), `${where}: Edit in folder · Read only · Full`);
  check(/Full: agents can run any command/.test(src), `${where.toUpperCase()}: FULL KEEPS ITS WARNING`);
}

/* ------------------------------------------------ 4. the resizable sidebar */

const shell = read('apps/web/src/shell/AppShell.tsx');
const side = shell.match(/const SIDE = \{ min: (\d+), max: (\d+), initial: (\d+), step: (\d+), key: '([^']+)' \}/);
check(!!side, 'the sidebar limits are declared in one place');
if (side) {
  const [, min, max, initial, step] = side.slice(0, 5).map(Number);
  check(min === 200 && max === 420 && initial === 248, `it can't go below 200 or above 420, and starts at 248 (found ${min}–${max}, ${initial})`);
  check(step === 16, 'the keyboard moves it by 16px');
  const clamp = (w) => Math.round(Math.min(max, Math.max(min, w)));
  check(clamp(100) === 200 && clamp(999) === 420 && clamp(360) === 360, 'a drag to 100 stops at 200, to 999 stops at 420, and 360 stays 360');
}
check(/Math\.min\(SIDE\.max, Math\.max\(SIDE\.min, w\)\)/.test(shell), 'every width, dragged, typed or stored, goes through that clamp');
check(/localStorage\.setItem\(SIDE\.key/.test(shell) && /localStorage\.getItem\(SIDE\.key\)/.test(shell), 'the width is remembered per browser');
check(/onDoubleClick=\{\(\) => commit\(SIDE\.initial\)\}/.test(shell), 'double-clicking the edge restores 248');
check(/role="separator"/.test(shell) && /aria-orientation="vertical"/.test(shell), 'the edge is a vertical separator');
check(/aria-valuenow=\{width\}/.test(shell) && /aria-valuemin=\{SIDE\.min\}/.test(shell) && /aria-valuemax=\{SIDE\.max\}/.test(shell), 'it states its current, minimum and maximum width');
check(/tabIndex=\{0\}/.test(shell) && /ArrowLeft: -SIDE\.step, ArrowRight: SIDE\.step/.test(shell), 'it is focusable, and ← → resize it');
check(/@media \(max-width: 900px\) \{ \.side-resize \{ display: none; \} \}/.test(read('apps/web/src/styles.css')), 'narrow screens keep the drawer and have no handle');

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM36 checks passed');
process.exit(0);
