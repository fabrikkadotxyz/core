/**
 * M52 acceptance: Permissions in a dialog, and a default you keep (ADR 0049).
 *
 * Against the server: a default is saved per person and slug, listed, and
 * applied to a room's grants exactly (allow these, deny the rest); the owner's
 * attach applies it when the room has no grant for that slug; a member's attach
 * applies nothing; applying is owner-only. From the source: one Permissions
 * button per row opens a dialog, the tool list no longer sits in the tab, the
 * presets live in the dialog, and the MCP protocol is untouched.
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

/* ------------------------------------------------ 1. the dialog, in the source */

const page = read('apps/web/src/pages/SessionPage.tsx');
check(/function PermissionsDialog\(/.test(page) && /<Modal label=\{`\$\{label\} — what this session allows`\}/.test(page), 'the grant list is a dialog over the room');
check((page.match(/onClick=\{\(\) => setPermissions\(\{ slug: [mt]\.slug, label: [mt]\.label \}\)\}>\s*Permissions/g) ?? []).length === 2, 'ONE PERMISSIONS BUTTON PER ROW, yours and the organization\'s');
check(!/what this session allows<\/h3>/.test(page), 'the tool list no longer sits in the Tools tab');
check(/placeholder="Filter tools"/.test(page) && /\$\{allowed\} of \$\{list\.length\} allowed/.test(page), 'a filter box and a count');
check(/disabled=\{!isOwner\}/.test(page) && /Only the session owner can change grants/.test(page), 'a non-owner sees the boxes disabled');
check(page.indexOf("(['none', 'read', 'write'] as const)") > page.indexOf('function PermissionsDialog('), 'the M18 presets live in the dialog');
check(/connections\.saveGrantDefault\(slug, tools\)/.test(page) && /sessions\.applyGrantDefault\(ref_, slug\)/.test(page), 'Save as my default and Apply my default, in the footer');
const modal = read('apps/web/src/components/Modal.tsx');
check(/<dialog/.test(modal) && /showModal\(\)/.test(modal) && /onCancel=/.test(modal), 'the modal is the browser\'s own dialog: modal focus, Escape closes');
check(!/grant_defaults|grant-defaults|apply-default/.test(read('docs/protocol.md')), 'the MCP protocol did not change');

/* ------------------------------------------------ 2. defaults, on the server */

async function signIn(email, password) {
  const r = await fetch(`${CORE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`);
  return r.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session=')).split(';')[0];
}
const as = (cookie) => (path, init = {}) =>
  fetch(`${CORE}/api${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), cookie, connection: 'close' }, body: init.body ? JSON.stringify(init.body) : undefined });

const owner = as(await signIn(EMAIL, PASSWORD));
const stamp = Date.now();
const SLUG = `m52-${stamp}`;

// A connection of the owner's, with no real server behind it: grants and defaults need none.
let r = await owner('/me/connections', { method: 'POST', body: { slug: SLUG, url: 'http://127.0.0.1:9/mcp', label: 'M52 vendor', teamId: null } });
check(r.status === 201, 'a connection to attach (no server behind it: grants need none)');

r = await owner(`/me/grant-defaults/${SLUG}`, { method: 'PUT', body: { tools: ['list_things', 'read_thing', 'list_things'] } });
check(r.status === 200 && (await r.json()).tools === 2, 'SAVE A DEFAULT: a list of tool names, de-duplicated');
r = await owner('/me/grant-defaults');
const listed = (await r.json()).defaults.find((d) => d.slug === SLUG);
check(listed && listed.name === 'default' && listed.tools.join() === 'list_things,read_thing', 'it is listed under your account, named default');
r = await owner(`/me/grant-defaults/${SLUG}`, { method: 'PUT', body: { tools: ['x'], name: 'release-day' } });
check(r.status === 400, 'only the default is named today (the key carries the name for later)');
r = await owner(`/me/grant-defaults/${SLUG}`, { method: 'PUT', body: { tools: 'read_thing' } });
check(r.status === 400, 'tools must be a list');

// Room A: the owner attaches → the default fills in the grants.
const A = await (await owner('/sessions', { method: 'POST', body: { title: `M52 A ${stamp}` } })).json();
const baseA = `/o/${A.ownerSlug}/s/${A.publicId}`;
r = await owner(`${baseA}/integrations`, { method: 'POST', body: { slug: SLUG } });
const attached = await r.json();
check(r.status === 201 && attached.defaultApplied === 2, "THE OWNER'S ATTACH APPLIES THEIR DEFAULT when the room has no grant for that slug");
let grants = (await (await owner(`${baseA}/integrations`)).json()).grants.filter((g) => g.serverSlug === SLUG && g.allowed).map((g) => g.toolName).sort();
check(grants.join() === 'list_things,read_thing', '…and the room allows exactly those tools');

// Room B: grants exist already; apply-default replaces them exactly.
const B = await (await owner('/sessions', { method: 'POST', body: { title: `M52 B ${stamp}` } })).json();
const baseB = `/o/${B.ownerSlug}/s/${B.publicId}`;
await owner(`${baseB}/integrations/${SLUG}/tools/delete_thing`, { method: 'PUT', body: { allowed: true } });
r = await owner(`${baseB}/integrations`, { method: 'POST', body: { slug: SLUG } });
check(r.status === 201 && (await r.json()).defaultApplied === null, 'a room that already has a grant for the slug keeps it on attach');
r = await owner(`${baseB}/integrations/${SLUG}/grants/apply-default`, { method: 'POST', body: {} });
check(r.status === 200 && (await r.json()).allowed === 2, 'APPLY MY DEFAULT');
grants = (await (await owner(`${baseB}/integrations`)).json()).grants.filter((g) => g.serverSlug === SLUG);
check(grants.filter((g) => g.allowed).map((g) => g.toolName).sort().join() === 'list_things,read_thing' && grants.some((g) => g.toolName === 'delete_thing' && !g.allowed), '…makes the grants EXACTLY the saved set: delete_thing, ticked before, is now denied');
r = await owner(`${baseB}/integrations/other-${stamp}/grants/apply-default`, { method: 'POST', body: {} });
check(r.status === 404, 'no default for a slug: 404, nothing changes');

// A member: attaching applies nothing, applying is refused.
const memberEmail = `m52-member-${stamp}@example.com`;
r = await owner(`${baseB}/invites`, { method: 'POST', body: {} });
const invite = await r.json();
const token = invite.token ?? invite.url?.split('/').pop();
r = await fetch(`${CORE}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ token, email: memberEmail, password: 'password123', displayName: `M52 Member ${stamp}` }) });
const memberOk = r.ok;
check(memberOk, `a member joins room B through its invite (${r.status})`);
if (memberOk) {
  const member = as(r.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session=')).split(';')[0]);
  await member('/me/connections', { method: 'POST', body: { slug: SLUG, url: 'http://127.0.0.1:9/mcp', label: 'M52 vendor (member)', teamId: null } });
  await member(`/me/grant-defaults/${SLUG}`, { method: 'PUT', body: { tools: ['delete_thing', 'wipe_everything'] } });
  const C = await (await owner('/sessions', { method: 'POST', body: { title: `M52 C ${stamp}` } })).json();
  const baseC = `/o/${C.ownerSlug}/s/${C.publicId}`;
  const inv = await (await owner(`${baseC}/invites`, { method: 'POST', body: {} })).json();
  const t2 = inv.token ?? inv.url?.split('/').pop();
  await member(`/invites/${t2}/redeem`, { method: 'POST', body: {} });
  r = await member(`${baseC}/integrations`, { method: 'POST', body: { slug: SLUG } });
  const memberAttach = r.status === 201 ? await r.json() : null;
  check(memberAttach && memberAttach.defaultApplied === null, "A MEMBER'S ATTACH APPLIES NOTHING: a member cannot set grants");
  grants = (await (await owner(`${baseC}/integrations`)).json()).grants.filter((g) => g.serverSlug === SLUG && g.allowed);
  check(grants.length === 0, '…and room C still allows nothing for it');
  r = await member(`${baseC}/integrations/${SLUG}/grants/apply-default`, { method: 'POST', body: {} });
  check(r.status === 404, 'applying a default is owner-only');
}

r = await owner(`/me/grant-defaults/${SLUG}`, { method: 'DELETE' });
check(r.status === 200, 'a default can be removed');
r = await owner('/me/grant-defaults');
check(!(await r.json()).defaults.some((d) => d.slug === SLUG), '…and is gone');

const schema = read('packages/db/src/schema.ts');
check(/export const grantDefaults = pgTable\(\s*'grant_defaults'/.test(schema) && /primaryKey\(\{ columns: \[t\.userId, t\.serverSlug, t\.name\] \}\)/.test(schema), 'the table is keyed by person, slug and name (ADR 0049)');
check(/grant_defaults/.test(read('docs/data-model.md')), 'docs/data-model.md has it');

console.log(failures ? `\n${failures} FAILED` : '\nM52 checks passed');
process.exit(failures ? 1 : 0);
