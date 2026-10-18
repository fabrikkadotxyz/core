/**
 * M63 acceptance: retention, what the rooms keep (ADR 0058 amended).
 *
 * Against the server: an owner sets a 30-day window for messages and files
 * on a fresh organization; a member is refused; one message and one file row
 * are backdated through psql; `admin prune-retention` runs the job; the old
 * message and file are gone, the new ones and the room's context stay; the
 * trail has retention.pruned with counts and the owner's change; the choices
 * are the five listed; forever is null and the default.
 *
 * Requires: the core server (FABRIKKA_CORE, default :9090), the test account,
 * psql, and DATABASE_URL (.env) to backdate rows.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

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
const settle = () => new Promise((r) => setTimeout(r, 300));
const envFile = existsSync('.env') ? read('.env') : '';
const DATABASE_URL = process.env.DATABASE_URL ?? envFile.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim();
const psql = (q) => execFileSync('psql', [DATABASE_URL, '-tAc', q], { encoding: 'utf8' }).trim();
const admin = (...args) => execFileSync('pnpm', ['--silent', 'admin', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/* ------------------------------------------------ 1. the source */

const schema = read('packages/db/src/schema.ts');
check(/check\('teams_message_days', sql`\$\{t\.messageDays\} is null or \$\{t\.messageDays\} in \(30, 90, 180, 365, 730\)`\)/.test(schema), 'FIVE WINDOWS OR FOREVER, in the schema');
const ret = read('apps/server/src/retention.ts');
check(/o\.updated_at < now\(\) - make_interval\(days => t\.output_days\)/.test(ret) && /m\.created_at < now\(\) - make_interval\(days => t\.message_days\)/.test(ret), 'documents by last edit, messages by when written');
check(!/context_events|session_context|session_links|session_members/.test(ret), 'THE CONTEXT, LINKS AND ROSTER ARE NEVER TOUCHED');
check(/action: 'retention\.pruned'/.test(ret), 'every run that removed something is in the trail');
check(/What the rooms keep/.test(read('apps/web/src/pages/ActivityPage.tsx')), 'Settings → Activity → What the rooms keep');

/* ------------------------------------------------ 2. the server */

const owner = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
const stamp = Date.now();
const org = (await req('/teams', { method: 'POST', body: { name: `M63 org ${stamp}` }, cookie: owner })).json;
const inv = (await req(`/teams/${org.id}/invites`, { method: 'POST', body: {}, cookie: owner })).json;
const mem = await req('/auth/signup', { method: 'POST', body: { token: inv.token, email: `m63-mem-${stamp}@example.com`, password: 'password123', displayName: `Mem${stamp}` } });
const room = (await req('/sessions', { method: 'POST', body: { title: `M63 room ${stamp}`, teamId: org.id }, cookie: owner })).json;
const base = `/o/${room.ownerSlug}/s/${room.publicId}`;
const oldMsg = (await req(`${base}/messages`, { method: 'POST', body: { content: `OLD-${stamp}` }, cookie: owner })).json;
const newMsg = (await req(`${base}/messages`, { method: 'POST', body: { content: `NEW-${stamp}` }, cookie: owner })).json;
await req(`${base}/context`, { method: 'PATCH', body: { add: { decisions: [`DECIDED-${stamp}`] } }, cookie: owner });
const oldFile = (await req(`${base}/artifacts`, { method: 'POST', body: { type: 'link', name: `old-link-${stamp}`, url: 'https://example.com/old' }, cookie: owner })).json;
const newFile = (await req(`${base}/artifacts`, { method: 'POST', body: { type: 'link', name: `new-link-${stamp}`, url: 'https://example.com/new' }, cookie: owner })).json;

const before = (await req(`/teams/${org.id}/retention`, { cookie: owner })).json;
check(before && before.messageDays === null && before.outputDays === null && before.fileDays === null && before.choices.join() === '30,90,180,365,730', 'FOREVER BY DEFAULT, five choices');
check((await req(`/teams/${org.id}/retention`, { cookie: mem.cookie })).status === 404, 'a member cannot read the setting…');
check((await req(`/teams/${org.id}/retention`, { method: 'PUT', body: { messageDays: 30 }, cookie: mem.cookie })).status === 403, '…nor set it');
check((await req(`/teams/${org.id}/retention`, { method: 'PUT', body: { messageDays: 45 }, cookie: owner })).status === 400, 'only the listed windows');
const set = (await req(`/teams/${org.id}/retention`, { method: 'PUT', body: { messageDays: 30, fileDays: 30 }, cookie: owner })).json;
check(set.messageDays === 30 && set.fileDays === 30 && set.outputDays === null && set.pruned.messages === 0, 'THE OWNER SETS MESSAGES AND FILES TO 30 DAYS; nothing was older yet');

check(psql(`update messages set created_at = now() - interval '40 days' where id = '${oldMsg.id}'`) === 'UPDATE 1', 'one message is backdated 40 days (psql)');
check(psql(`update artifacts set created_at = now() - interval '40 days' where id = '${oldFile?.id ?? oldFile?.artifact?.id}'`) === 'UPDATE 1', 'and one file');
const out = admin('prune-retention', '--team', org.id);
check(/deleted 1 message\(s\), 0 document\(s\), 1 file\(s\)/.test(out), `THE JOB DELETES THEM: ${out.trim()}`);
const msgs = (await req(`${base}/messages`, { cookie: owner })).json;
const list = Array.isArray(msgs) ? msgs : msgs.messages ?? [];
check(!list.some((m) => m.id === oldMsg.id) && list.some((m) => m.id === newMsg.id), 'the old message is gone, the new one stays');
const files = (await req(`${base}/artifacts`, { cookie: owner })).json;
const fl = Array.isArray(files) ? files : files.artifacts ?? [];
check(!fl.some((a) => a.name === `old-link-${stamp}`) && fl.some((a) => a.name === `new-link-${stamp}`), 'the old file row is gone, the new one stays');
const ctx = (await req(`${base}/context`, { cookie: owner })).json;
check(JSON.stringify(ctx).includes(`DECIDED-${stamp}`), 'THE DECISION STAYS');
await settle();
const trail = (await req(`/teams/${org.id}/audit`, { cookie: owner })).json.events;
check(trail.some((e) => e.action === 'retention.pruned' && e.detail.messages === 1 && e.detail.files === 1 && e.actor.kind === 'system'), 'retention.pruned in the trail, with counts');
check(trail.some((e) => e.action === 'team.retention_changed' && e.detail.messageDays === 30), "…and the owner's change");
const reset = (await req(`/teams/${org.id}/retention`, { method: 'PUT', body: { messageDays: null, fileDays: null }, cookie: owner })).json;
check(reset.messageDays === null && reset.fileDays === null, 'back to forever');

// Tidy.
execFileSync('pnpm', ['--silent', 'admin', 'delete-user', '--email', `m63-mem-${stamp}@example.com`, '--now', '--yes'], { stdio: 'ignore' });
await req(base, { method: 'DELETE', cookie: owner });

console.log(failures ? `\n${failures} FAILED` : '\nM63 checks passed');
process.exit(failures ? 1 : 0);
