/**
 * M54 acceptance: add a folder from Add my agent (ADR 0052).
 *
 * Against the server: the route that asks one of your computers to open its
 * Folders window exists, refuses an organization you are not on and a
 * computer that is not yours, and carries nothing but the organization. From
 * the source: the dialog, the frame and the stdio event in the host, the
 * desktop command taking at most an organization, the Folders window
 * honouring the preselect, and the protocol and security docs saying so.
 *
 * Requires: the core server on :9090 and the test account.
 */
import { readFileSync } from 'node:fs';

const CORE = 'http://localhost:9090';
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
const read = (p) => readFileSync(p, 'utf8');

/* ------------------------------------------------ 1. the source */

const page = read('apps/web/src/pages/SessionPage.tsx');
check(/function FoldersDialog\(/.test(page) && /<Modal label=\{`Folders for \$\{org\.name\}`\}/.test(page), 'Add my agent has a Folders dialog for the room\'s organization');
check((page.match(/Add a folder…/g) ?? []).length >= 3, 'ADD A FOLDER… from the empty state, under the list, and per computer in the dialog');
check(/if \(inDesktopApp\(\)\) await openFolders\(org\.id\);\s*else await devices\.openFolders\(d\.id, org\.id\);/.test(page), 'the app is asked directly; a browser asks through the server');
check(/<ConnectCommand first=\{list\.length === 0\} \/>/.test(page), 'Connect another computer, with the install command, in the same dialog');
check(/window\.setInterval\(tick, foldersOpen \? 2000 : 5000\)/.test(page), 'the picker refreshes while picking, faster while the dialog is open');
check(!/menu-bar icon → Folders/.test(page), 'the sentence that sent you away is gone');
const host = read('packages/bridge/src/host/host.ts');
check(/frame\.type === 'open_folders' && typeof frame\.org === 'string' && this\.organizations\.some\(\(o\) => o\.id === frame\.org\)/.test(host), 'THE HOST HONOURS open_folders ONLY FOR AN ORGANIZATION IT KNOWS');
check(/send\(\{ event: 'open_folders', org \}\)/.test(host) && /open \$\{control\.url\} and add one/.test(host), 'under the app it pushes the stdio event; in a terminal it says where its page is');
const rs = read('apps/desktop/src-tauri/src/main.rs');
check(/fn open_folders\(app: AppHandle, org: Option<String>\)/.test(rs) && !/fn open_folders\([^)]*(path|policy)/.test(rs), 'the desktop command takes at most an organization: NO PATH, NO POLICY');
check(/Some\("open_folders"\)/.test(rs) && /state\["preselectOrg"\]/.test(rs), 'the app shows the window on the host\'s event and hands the page the organization once');
check(/s\.preselectOrg && orgs\.some\(\(o\) => o\.id === s\.preselectOrg\)/.test(read('apps/desktop/src/folders.html')), 'the Folders window preselects it in For');
check(/`\{ type: 'open_folders', org \}`/.test(read('docs/protocol.md')) && /`\{ event: 'open_folders', org \}`/.test(read('docs/protocol.md')), 'docs/protocol.md has the frame and the event');
check(/open-folders/.test(read('docs/security.md')) && /ADR 0052/.test(read('docs/security.md')), 'docs/security.md says what travels and what does not');

/* ------------------------------------------------ 2. the route */

const login = await fetch(`${CORE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const cookie = login.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session=')).split(';')[0];
const api = (path, init = {}) => fetch(`${CORE}/api${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), cookie, connection: 'close' }, body: init.body ? JSON.stringify(init.body) : undefined });
const own = (await (await api('/teams')).json()).find((t) => t.own);
let r = await api('/devices/00000000-0000-0000-0000-000000000000/open-folders', { method: 'POST', body: { teamId: own.id } });
check(r.status === 404, "a computer that is not yours (or none) is a 404");
r = await api('/devices/00000000-0000-0000-0000-000000000000/open-folders', { method: 'POST', body: { teamId: '00000000-0000-0000-0000-000000000000' } });
check(r.status === 404, 'an organization you are not on is a 404');
r = await api('/devices/00000000-0000-0000-0000-000000000000/open-folders', { method: 'POST', body: {} });
check(r.status === 404, 'no organization: refused');
const server = read('apps/server/src/app.ts');
check(/hostHub\.send\(device\.id, \{ type: 'open_folders', org: teamId \}\)/.test(server) && /is offline`\s*\}, 409\)/.test(server), 'THE FRAME CARRIES THE ORGANIZATION AND NOTHING ELSE; an offline computer is a 409');

console.log(failures ? `\n${failures} FAILED` : '\nM54 checks passed');
process.exit(failures ? 1 : 0);
