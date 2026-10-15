/**
 * M51 acceptance: the workspace is an icon rail of four places (ADR 0048).
 *
 * From the source and the server: the rail is Sessions · Chats · Integrations
 * · Settings; the place follows the page and a click changes the list, not the
 * room; Integrations has its own addresses and the old settings addresses
 * forward there with their query; the OAuth callback comes back to
 * /integrations; the sidebar lists one place at a time; the rail adds no theme
 * token. The visual part is the manual test in docs/roadmap.md.
 *
 * Requires: the core server on :9090.
 */
import { readFileSync } from 'node:fs';

const CORE = 'http://localhost:9090';
let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const read = (p) => readFileSync(p, 'utf8');

/* ------------------------------------------------ 1. the rail */

const rail = read('apps/web/src/shell/Rail.tsx');
check(/export const PLACES: Place\[\] = \['sessions', 'chats', 'integrations', 'settings'\]/.test(rail), 'FOUR PLACES, in this order: Sessions · Chats · Integrations · Settings');
check(/<nav className="rail-nav" aria-label="Places">/.test(rail) && /className="rail-home"/.test(rail) && /className="rail-account"/.test(rail), 'the rail is one nav: the mark (Home) above the places, the account below');
check(/s\.kind === 'chat' \|\| s\.kind === 'direct' \? 'chats' : 'sessions'/.test(rail), 'a chat or a direct message belongs under Chats; everything else under Sessions (ADR 0026)');
check(/pathname\.startsWith\('\/integrations'\)/.test(rail) && /pathname\.startsWith\('\/settings'\)/.test(rail), 'the place follows the page');
check(/reduce\(\(n, s\) => n \+ needsYou\(s\), 0\)/.test(rail) && /className="rail-count"/.test(rail) && /className="rail-dot"/.test(rail), 'Sessions and Chats carry the needs-you number and the unread dot (M42)');

const shell = read('apps/web/src/shell/AppShell.tsx');
check(/<Rail place=\{place\} onPick=\{pickPlace\} \/>/.test(shell) && /<Sidebar place=\{place\}/.test(shell), 'the rail and the list share one place');
check(/setPick\(\{ path: location\.pathname, place: p \}\)/.test(shell) && /pick\?\.path === location\.pathname \? pick\.place/.test(shell), 'CLICKING A PLACE WHILE A ROOM IS OPEN CHANGES THE LIST, NOT THE PAGE, and only for that address');
check(/navigate\('\/', \{ state: \{ place: p \} \}\)/.test(shell), 'from another page, Sessions and Chats go home with that list shown');
check(/<div className="side-stack">/.test(shell), 'on a phone the rail and the list are one drawer');

/* ------------------------------------------------ 2. the list, one place at a time */

const side = read('apps/web/src/shell/Sidebar.tsx');
check(/\{place === 'sessions' && team && \(/.test(side) && /\{place === 'chats' && team && \(/.test(side) && /\{place === 'integrations' && \(/.test(side) && /\{place === 'settings' && \(/.test(side), 'the list shows one place: sessions, chats, integrations or settings');
check(/teamSessions\.map\(/.test(side) && !/RECENT/.test(side), 'ALL of the organization\'s active sessions are listed, not five and a link');
check(/to="\/integrations" end label="Personal"/.test(side) && /to="\/integrations\/organization"/.test(side), 'Integrations lists Personal and the organization\'s');
check(/to="\/settings\/people"/.test(side) && /to="\/settings\/devices"/.test(side) && /to="\/settings\/appearance"/.test(side), 'Settings lists People, Your devices, Appearance');
check(/\{place === 'settings' && \(\s*<div className="side-bottom">/.test(side) && /Sign out/.test(side) && /AGPL-3\.0/.test(side), 'who you are, Sign out and the source link sit under Settings');
check(/\{rooms && <NotifyOffer/.test(side), 'the notification offer (M42) lives with the rooms');

/* ------------------------------------------------ 3. addresses */

const app = read('apps/web/src/App.tsx');
check(/path="\/integrations" element=\{<IntegrationsHubPage scope="personal" \/>\}/.test(app) && /path="\/integrations\/organization" element=\{<IntegrationsHubPage scope="organization" \/>\}/.test(app), 'INTEGRATIONS HAS ITS OWN ADDRESSES: /integrations and /integrations/organization');
const settings = read('apps/web/src/pages/SettingsPage.tsx');
check(/tab === 'integrations'\) return <Navigate to=\{`\/integrations\$\{search\}`\} replace \/>/.test(settings) && /tab === 'organization'\) return <Navigate to=\{`\/integrations\/organization\$\{search\}`\} replace \/>/.test(settings), 'the old settings tabs forward there, keeping their query');
check(!/settings-tabs/.test(settings) && !/settings-tabs/.test(read('apps/web/src/styles.css')), 'the Settings screen has no tab row of its own: the list is the navigation');
const server = read('apps/server/src/app.ts');
check(/c\.redirect\(`\/integrations\?error=/.test(server) && /const back = `\/integrations\?connected=/.test(server) && !/settings\/integrations/.test(server), 'THE OAUTH CALLBACK COMES BACK TO /integrations');
for (const f of ['apps/web/src/components/GettingStarted.tsx', 'apps/web/src/pages/SessionPage.tsx']) {
  check(!/settings\/integrations/.test(read(f)), `${f.split('/').pop()} links to /integrations`);
}
check(/\/integrations/.test(read('apps/web/src/components/GettingStarted.tsx')), 'Getting started\'s "connect a tool" still leads to Integrations');

/* ------------------------------------------------ 4. the server serves the new addresses as the app */

for (const path of ['/integrations', '/integrations/organization', '/settings/people']) {
  const r = await fetch(`${CORE}${path}`, { headers: { connection: 'close' } });
  const html = await r.text();
  check(r.ok && /<div id="root">|<script type="module"/.test(html), `${path} is served as the app`);
}

/* ------------------------------------------------ 5. themes */

const css = read('apps/web/src/styles.css');
const railBlock = css.slice(css.indexOf('M51: the icon rail'));
const tokens = [...railBlock.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]);
check(tokens.length > 0 && tokens.every((t) => ['side-bg', 'side-muted', 'side-border', 'side-strong', 'side-hover', 'side-selected', 'grad-attention', 'radius-pill', 'rail-w', 'side-w'].includes(t)), `the rail uses the sidebar's tokens only, no new one (${[...new Set(tokens)].join(', ')})`);
check(/icon rail of places beside it \(M51, ADR 0048\)/.test(read('docs/themes.md')), 'docs/themes.md says so');
check(/\| \[0048\]\(0048-the-workspace-is-an-icon-rail-of-four-places\.md\)/.test(read('docs/decisions/README.md')), 'ADR 0048 is in the index');

console.log(failures ? `\n${failures} FAILED` : '\nM51 checks passed');
process.exit(failures ? 1 : 0);
