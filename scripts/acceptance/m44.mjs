/**
 * M44 acceptance: themes (ADR 0038, docs/themes.md).
 *
 * What can be checked without a person: the six built-in themes are offered in
 * order; only checked files are served, typed and nosniff; a choice is saved
 * per account, and a theme the instance doesn't offer is refused; the page
 * paints the cached theme before the app loads. How each theme looks stays the
 * manual test.
 *
 * Requires: the server on :9090 and the test account (_setup.mjs).
 */
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:9090';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};

/* ------------------------------------------------ 1. what's offered */

const list = await (await fetch(`${BASE}/api/themes`)).json();
check(list.themes.map((t) => t.id).join() .startsWith('dusk,dusk-night,terminal,paper,brutal,aurora'), 'the six built-in themes are offered, in order, without signing in');
check(list.default === 'dusk' && list.system.light === 'dusk' && list.system.dark === 'dusk-night', 'Dusk is the default; Match my system is Dusk and Dusk Night');
check(list.themes.every((t) => (t.scheme === 'light' || t.scheme === 'dark') && t.swatches.length >= 2), 'each theme has a scheme and swatches for its card');
check(list.themes.every((t) => !('files' in t)), 'the listing exposes no file paths');

/* ------------------------------------------------ 2. what's served */

const css = await fetch(`${BASE}/themes/terminal/theme.css`);
check(css.ok && css.headers.get('content-type')?.startsWith('text/css') && css.headers.get('x-content-type-options') === 'nosniff', "a theme's CSS is served as CSS, with nosniff");
check((await css.text()).includes('--font-ui'), '…and it sets tokens from the contract');
check((await fetch(`${BASE}/themes/terminal/x.svg`)).status === 404, 'A FILE THE PACK DOES NOT HAVE IS 404');
check((await fetch(`${BASE}/themes/nope/theme.css`)).status === 404, 'a theme that does not exist is 404');
const escape = await fetch(`${BASE}/themes/terminal/%2e%2e/%2e%2e/package.json`);
check(!(await escape.text()).includes('"name": "@fabrikka/server"'), 'NO ../ PATH RETURNS A FILE FROM OUTSIDE THE PACK');

/* ------------------------------------------------ 3. choosing, per account */

const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const cookie = login.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='))?.split(';')[0] ?? '';
const api = (path, init = {}) => fetch(`${BASE}/api${path}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });

check((await fetch(`${BASE}/api/me/theme`)).status === 401, 'the saved choice needs a login');
check((await api('/me/theme', { method: 'PUT', body: JSON.stringify({ theme: 'terminal' }) })).ok, 'choosing Terminal is saved');
check((await (await api('/me/theme')).json()).theme === 'terminal', '…and read back for the account (so every device gets it)');
check((await api('/me/theme', { method: 'PUT', body: JSON.stringify({ theme: 'system' }) })).ok, 'Match my system is a choice too');
check((await api('/me/theme', { method: 'PUT', body: JSON.stringify({ theme: '../../etc' }) })).status === 400, 'A THEME THE INSTANCE DOES NOT OFFER IS REFUSED');
check((await api('/me/theme', { method: 'PUT', body: JSON.stringify({ theme: null }) })).ok && (await (await api('/me/theme')).json()).theme === null, 'null goes back to the default');

/* ------------------------------------------------ 4. no flash */

const html = await (await fetch(`${BASE}/`)).text();
const scriptAt = html.indexOf('fabrikka.theme');
check(scriptAt !== -1 && scriptAt < html.indexOf('id="root"'), 'index.html applies the cached theme before the app renders');
check(/document\.write\('<link id="theme-css"/.test(html), '…with a render-blocking stylesheet, so there is no flash of Dusk');
const app = readFileSync('apps/web/src/styles.css', 'utf8');
check(!/\[data-theme="dark"\]/.test(app), "the dark palette lives in the Dusk Night pack, not in the app's stylesheet");

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM44 checks passed');
process.exit(0);
