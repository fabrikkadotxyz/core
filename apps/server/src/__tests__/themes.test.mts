/** Themes (M44, ADR 0038): the manifest and CSS checks, and every built-in pack. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCss, loadPack, loadThemes, parseManifest, themeDirs, ThemeError } from '../themes.ts';

let fails = 0;
const ok = (label: string, cond: boolean) => {
  if (cond) console.log('ok  ', label);
  else { console.error('FAIL', label); fails++; }
};
const refuses = (label: string, fn: () => unknown) => {
  try { fn(); ok(label, false); } catch (e) { ok(label, e instanceof ThemeError); }
};
const files = new Set(['theme.json', 'theme.css', 'fonts/a.woff2']);
const manifest = { contract: 1, id: 'x', name: 'X', description: 'd', scheme: 'dark', swatches: ['#000000', '#ffffff'] };

ok('a valid manifest parses', parseManifest(manifest).id === 'x');
refuses('an unsupported contract is refused', () => parseManifest({ ...manifest, contract: 2 }));
refuses('an id with a slash is refused', () => parseManifest({ ...manifest, id: '../x' }));
refuses('a scheme other than light or dark is refused', () => parseManifest({ ...manifest, scheme: 'blue' }));
refuses('one swatch is too few', () => parseManifest({ ...manifest, swatches: ['#000000'] }));

ok('a relative url inside the pack is allowed', (checkCss('@font-face{src:url("fonts/a.woff2")}', files), true));
ok('./ prefix is allowed', (checkCss("a{background:url(./fonts/a.woff2)}", files), true));
refuses('AN https URL IS REFUSED (no fetching from elsewhere)', () => checkCss('a{background:url(https://evil.example/x.png)}', files));
refuses('a protocol-relative URL is refused', () => checkCss('a{background:url(//evil.example/x.png)}', files));
refuses('an absolute path on the instance is refused', () => checkCss('a{background:url(/api/me)}', files));
refuses('a data: URL is refused', () => checkCss('a{background:url(data:image/png;base64,AAAA)}', files));
refuses('.. out of the pack is refused', () => checkCss('a{background:url(../other/theme.css)}', files));
refuses('a file the pack does not have is refused', () => checkCss('a{background:url(images/missing.png)}', files));
refuses('AN ESCAPED url( IS REFUSED (\\75rl spells url)', () => checkCss('a{background:\\75rl(https://evil.example/x)}', files));
refuses('image-set() with a bare string is refused', () => checkCss('a{background:image-set("https://evil.example/x" 1x)}', files));
refuses('@import is refused', () => checkCss('@import "x.css";', files));
refuses('expression() is refused', () => checkCss('a{width:expression(alert(1))}', files));
refuses('javascript: is refused', () => checkCss('a{background:url(javascript:alert(1))}', files));
refuses('over 256 KB is refused', () => checkCss('a{}'.padEnd(257 * 1024, ' '), files));
ok('a URL hidden in a comment is ignored, not a hole', (checkCss('/* url(https://x) */ a{}', files), true));

// A pack on disk: an SVG makes it refused.
const dir = mkdtempSync(join(tmpdir(), 'theme-'));
mkdirSync(join(dir, 'p'));
writeFileSync(join(dir, 'p', 'theme.json'), JSON.stringify({ ...manifest, id: 'p' }));
writeFileSync(join(dir, 'p', 'theme.css'), ':root{--bg:#000}');
ok('a minimal pack loads', loadPack(join(dir, 'p'), false).id === 'p');
writeFileSync(join(dir, 'p', 'logo.svg'), '<svg onload="alert(1)"/>');
refuses('A PACK SHIPPING AN SVG IS REFUSED', () => loadPack(join(dir, 'p'), false));

// The built-ins all pass, in the picker's order.
const quiet = { log: () => {}, warn: (m: string) => console.error(m) };
const builtIn = loadThemes(themeDirs().filter((d) => d.builtIn), quiet as unknown as Console);
ok('the six built-in themes load, in order', [...builtIn.keys()].join() === 'dusk,dusk-night,terminal,paper,brutal,aurora');

if (fails) { console.error(`\n${fails} failure(s)`); process.exit(1); }
console.log('\nthemes: all passed');
