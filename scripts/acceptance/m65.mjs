/**
 * M65 acceptance: notes, not a form (ADR 0059).
 *
 * Against the server: an agent and a person add notes at once and both
 * survive; a repeat add is not duplicated; a bad tag is refused and a spaced
 * one normalised; removal is soft and shows in the history; the old context
 * tools are not offered; a template seeds tagged notes by nobody; the catch-up
 * says Noted. From the source: the panel is collapsed by default, the
 * migration carries the old form over as tagged notes, and nothing reads a tag.
 *
 * Requires: the core server (FABRIKKA_CORE, default :9090) and the test account.
 */
import { readFileSync } from 'node:fs';

const CORE = process.env.FABRIKKA_CORE ?? 'http://localhost:9090';
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
async function req(path, { method = 'GET', body, cookie } = {}) {
  const r = await fetch(`${CORE}/api${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), connection: 'close' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  const set = r.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='));
  return { status: r.status, json, cookie: set ? set.split(';')[0] : undefined };
}
async function tool(url, token, name, args = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.text();
  const payload = body.includes('data: ') ? JSON.parse(body.split('data: ').pop()) : JSON.parse(body);
  const result = payload.result;
  if (payload.error || result?.isError) return { error: payload.error?.message ?? result?.content?.[0]?.text ?? 'error' };
  const text = result?.content?.[0]?.text;
  try { return { value: JSON.parse(text) }; } catch { return { value: text }; }
}
async function toolList(url, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const body = await res.text();
  const payload = body.includes('data: ') ? JSON.parse(body.split('data: ').pop()) : JSON.parse(body);
  return (payload.result?.tools ?? []).map((t) => t.name);
}

/* ------------------------------------------------ 1. the source */

const page = read('apps/web/src/pages/SessionPage.tsx');
check(/<details className="notes">/.test(page) && !/<details className="notes" open/.test(page), 'THE NOTES PANEL IS COLLAPSED BY DEFAULT');
check(!/ContextPanel|Open questions|Constraints/.test(page), 'the form is gone from the room');
const mig = read('packages/db/migrations/0046_notes-drop.sql');
check(/INSERT INTO session_notes[\s\S]*'goal'[\s\S]*'fact'[\s\S]*'decision'[\s\S]*'question'[\s\S]*'constraint'/.test(mig) && mig.indexOf('INSERT INTO session_notes') < mig.indexOf('DROP TABLE'), 'THE OLD FORM MIGRATES AS TAGGED NOTES, before the tables go');
const srv = read('apps/server/src/sessions.ts');
check(/TAG_SHAPE = \/\^\[a-z0-9\]\[a-z0-9-\]\{0,31\}\$\//.test(srv), 'a tag is one lowercase word');
check(!/tag === '(goal|decision|fact|question|constraint)'/.test(read('apps/server/src/catchup.ts') + read('apps/server/src/export.ts') + srv), 'NOTHING IN FABRIKKA READS A TAG');
check(!/get_session_context|update_session_context/.test(read('apps/server/src/mcp.ts')), 'the old tools are gone from the server');
check(/get_notes/.test(read('docs/protocol.md')) && !/\| `get_session_context`/.test(read('docs/protocol.md')), 'and from the protocol');

/* ------------------------------------------------ 2. the server */

const fede = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
const stamp = Date.now();
const S = (await req('/sessions', { method: 'POST', body: { title: `M65 notes ${stamp}`, visibility: 'private' }, cookie: fede })).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const mcpUrl = `${CORE}/mcp/o/${S.ownerSlug}/s/${S.publicId}`;
const agent = (await req(`${base}/agents`, { method: 'POST', body: { displayName: `noter-${stamp}`, provider: 'claude-code' }, cookie: fede })).json;

const tools = await toolList(mcpUrl, agent.token);
check(['get_notes', 'add_note', 'remove_note'].every((t) => tools.includes(t)) && !tools.includes('get_session_context') && !tools.includes('update_session_context'), 'THREE NOTE TOOLS, AND THE OLD TWO ARE NOT OFFERED');

// Both write at once; both survive.
const [mine, theirs] = await Promise.all([
  req(`${base}/notes`, { method: 'POST', body: { text: `Fede's note ${stamp}` }, cookie: fede }),
  tool(mcpUrl, agent.token, 'add_note', { text: `Agent's note ${stamp}`, tag: 'finding' }),
]);
check(mine.status === 201 && mine.json.tag === null && !theirs.error && theirs.value.tag === 'finding', 'a person and an agent write at the same moment');
let notes = (await req(`${base}/notes`, { cookie: fede })).json;
check(notes.length === 2 && notes.map((n) => n.text).sort().join('|') === [`Agent's note ${stamp}`, `Fede's note ${stamp}`].join('|'), 'BOTH SURVIVE');
check(notes.find((n) => n.text.startsWith('Agent'))?.by === `noter-${stamp}` && notes.find((n) => n.text.startsWith('Fede'))?.by, 'each note says who wrote it');

const repeat = await tool(mcpUrl, agent.token, 'add_note', { text: `Agent's note ${stamp}`, tag: 'finding' });
check(repeat.value?.id === theirs.value.id && (await req(`${base}/notes`, { cookie: fede })).json.length === 2, 'adding the same text again returns the note, not a duplicate');
check((await req(`${base}/notes`, { method: 'POST', body: { text: 'x', tag: 'two words?' }, cookie: fede })).status === 400, 'a tag that is not one word is refused');
const spaced = (await req(`${base}/notes`, { method: 'POST', body: { text: `spaced ${stamp}`, tag: ' Open Question ' }, cookie: fede })).json;
check(spaced.tag === 'open-question', 'a spaced tag is normalised to one lowercase word');
check((await req(`${base}/notes`, { method: 'POST', body: { text: '   ' }, cookie: fede })).status === 400, 'an empty note is refused');

check((await req(`${base}/notes/${spaced.id}`, { method: 'DELETE', cookie: fede })).status === 200, 'a person removes a note');
notes = (await req(`${base}/notes`, { cookie: fede })).json;
check(!notes.some((n) => n.id === spaced.id), '…and it is gone from the live list');
const history = (await req(`${base}/notes?removed=1`, { cookie: fede })).json;
const gone = history.find((n) => n.id === spaced.id);
check(gone && gone.removedAt && gone.removedBy, 'REMOVAL IS SOFT: the history has it, with who and when');
check((await tool(mcpUrl, agent.token, 'remove_note', { id: spaced.id })).error, 'removing it again is an error, not a second removal');
check((await tool(mcpUrl, agent.token, 'get_notes')).value.length === 2, 'the agent reads the two live notes');

// A template seeds tagged notes, by nobody.
const T = (await req('/sessions', { method: 'POST', body: { title: `M65 incident ${stamp}`, templateRef: 'builtin:incident' }, cookie: fede })).json;
const seeded = (await req(`/o/${T.ownerSlug}/s/${T.publicId}/notes`, { cookie: fede })).json;
check(seeded.length === 3 && seeded.every((n) => n.by === null) && seeded.map((n) => n.tag).sort().join() === 'constraint,goal,question', 'A TEMPLATE SEEDS TAGGED NOTES, written by nobody');

// The catch-up says Noted.
const inv = (await req(`${base}/invites`, { method: 'POST', body: {}, cookie: fede })).json;
const al = await req('/auth/signup', { method: 'POST', body: { token: inv.token, email: `m65-al-${stamp}@example.com`, password: 'password123', displayName: `Al${stamp}` } });
await req(`${base}/seen`, { method: 'POST', cookie: al.cookie });
await tool(mcpUrl, agent.token, 'add_note', { text: `while Al was away ${stamp}`, tag: 'decision' });
const cu = (await req(`${base}/catch-up`, { cookie: al.cookie })).json;
check(cu.firstVisit === false && cu.notes.length === 1 && cu.notes[0].text === `while Al was away ${stamp}` && cu.notes[0].tag === 'decision' && cu.removedNotes.length === 0, 'THE CATCH-UP SAYS NOTED, with the tag, and nothing removed');

console.log(failures ? `\n${failures} FAILED` : '\nM65 checks passed');
process.exit(failures ? 1 : 0);
