/**
 * M50 acceptance: Setup, one question at a time.
 *
 * Always, from the source and the API: the Setup rail is four tabs (People,
 * Agents, Tools, Room) with the one shown remembered per room; People is one
 * list built from members that carry their participant; the invite form and
 * the by-hand attach form are closed until asked for; a chat offers People and
 * Agents only; Room is the owner's. The visual part is the manual test in
 * docs/roadmap.md.
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

/* ------------------------------------------------ 1. the rail, in the source */

const page = read('apps/web/src/pages/SessionPage.tsx');
check(/const SETUP_TABS: SetupTab\[\] = \['people', 'agents', 'tools', 'room'\]/.test(page), 'Setup is four tabs: People, Agents, Tools, Room');
check(/<nav className="tabs setup-tabs" role="tablist" aria-label="Setup">/.test(page), 'the tabs are a real tablist, in the rail');
check(/setupTab: SETUP_TABS\.includes\(parsed\.setupTab as SetupTab\)/.test(page) && /setupTab: 'people'/.test(page), 'THE TAB LAST USED IS REMEMBERED PER ROOM, with People first');
check(/setupTab === 'people' && \(\s*<PeoplePanel/.test(page) && /setupTab === 'agents' && \(\s*<AgentsPanel/.test(page) && /setupTab === 'tools' && !isChat && <IntegrationsPanel/.test(page) && /setupTab === 'room' && !isChat && isOwner && \(\s*<RoomPanel/.test(page), 'one panel shows at a time; a chat has no Tools and no Room; Room is the owner\'s');
check(/\.\.\.\(!isChat \? \[\{ key: 'tools' as const/.test(page) && /\.\.\.\(!isChat && isOwner \? \[\{ key: 'room' as const/.test(page), 'the tabs offered follow the same rule, so a chat shows People and Agents only');
check(!/<Panel title="Participants">/.test(page) && !/<Panel title={`Members/.test(page) && /function PeoplePanel\(/.test(page), 'PEOPLE IS ONE LIST: no Participants panel beside a Members panel');
check(/m\.participantName \?\? m\.displayName/.test(page) && /renameRow\(m\.participantId!, name\)/.test(page), 'a person\'s row shows the name they go by here, and rename works from it');
check(/\{isOwner && !isChat && !inviting && \(/.test(page) && /function InviteForm\(/.test(page) && /window\.setTimeout\(onCopied, 600\)/.test(page), 'the invite form opens from one Invite button and closes once the link is copied');
check(/Everyone on \{org\.name\} can read along/.test(page) && /function PeoplePanel\(/.test(page) && page.indexOf('Everyone on {org.name} can read along') > page.indexOf('function PeoplePanel('), 'the organization\'s read-along switch lives in People');
check(/<details className="setup-disclosure">\s*<summary>Connect by hand/.test(page), 'the by-hand attach form is behind a disclosure, closed until asked for');
check(/<h3 className="subhead">Attach a connection<\/h3>/.test(page) && /<span className="row-end">\s*<button className="link small" onClick=\{\(\) => attachOne\(a\.slug\)\}>/.test(page), 'your connections are one row each with Attach at the row\'s end');
check(/function RoomPanel\(/.test(page) && /onBlur=\{saveTitle\}/.test(page) && /className="stack danger-zone"/.test(page) && /Delete room/.test(page), 'Room: the name is renamed inline; Delete is last, in the danger zone');
check(/title="People, agents, tools, room"/.test(page), 'the header\'s Setup toggle names the four tabs');
const css = read('apps/web/src/styles.css');
check(/\.participants li:has\(\.row-end\) \{ flex-wrap: nowrap; \}/.test(css), 'a row with an action at its end never wraps');

/* ------------------------------------------------ 2. members carry their participant */

const login = await fetch(`${CORE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const cookie = login.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session=')).split(';')[0];
const api = (path, init = {}) => fetch(`${CORE}/api${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), cookie, connection: 'close' } });
const S = await (await api('/sessions', { method: 'POST', body: JSON.stringify({ title: `M50 ${Date.now()}` }) })).json();
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const view = await (await api(base)).json();
const me = view.members.find((m) => m.role === 'owner');
check(!!me && typeof me.participantId === 'string' && me.participantId === view.me.participantId, 'A MEMBER CARRIES THEIR PARTICIPANT, so People needs no second list');
check(me.participantName === view.participants.find((p) => p.id === me.participantId)?.displayName, '…and the name they go by in this room');
const types = read('packages/types/src/index.ts');
check(/participantId\?: string \| null;/.test(types) && /participantName\?: string \| null;/.test(types), 'the Member type says so (REST view only; list_participants in the protocol is untouched)');
check(!/participantName/.test(read('docs/protocol.md')), 'the MCP protocol did not change');

console.log(failures ? `\n${failures} FAILED` : '\nM50 checks passed');
process.exit(failures ? 1 : 0);
