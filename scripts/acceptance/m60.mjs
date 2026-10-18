/**
 * M60 acceptance: the trail (ADR 0058).
 *
 * Against the server: two accounts perform a dozen privileged actions in an
 * organization; each leaves one event with the expected action, actor, subject
 * and room; no event carries message content or tool arguments; a member is
 * refused the organization's trail and sees their own; the CSV has the rows;
 * shortening retention is recorded; the operator's `admin audit` lists it.
 * From the source: the writer never throws, and the fixed list of actions.
 *
 * Requires: the core server (FABRIKKA_CORE, default :9090) and the test
 * account.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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
  return { status: r.status, json, text, cookie: set ? set.split(';')[0] : undefined, type: r.headers.get('content-type') ?? '' };
}
const settle = () => new Promise((r) => setTimeout(r, 300)); // the trail is written after the response

/* ------------------------------------------------ 1. the source */

const auditSrc = read('apps/server/src/audit.ts');
check(/export async function audit\(db: Database, e: AuditInput\): Promise<void> \{\s*try \{[\s\S]*?\} catch \(err\) \{\s*console\.warn/.test(auditSrc), 'THE WRITER NEVER THROWS into the action it describes');
check(/export const AUDIT_ACTIONS = \[/.test(auditSrc) && /'member\.removed'/.test(auditSrc) && /'grant\.changed'/.test(auditSrc) && /'session\.exported'/.test(auditSrc), 'the actions are a fixed list');
check(/check\('teams_audit_days', sql`\$\{t\.auditDays\} in \(90, 180, 365, 730\)`\)/.test(read('packages/db/src/schema.ts')), 'retention is one of four answers');
check(/key: 'activity', label: 'Activity', org: true/.test(read('apps/web/src/pages/SettingsPage.tsx')), 'Settings → Activity, for an organization');
check(/<MyActivity \/>/.test(read('apps/web/src/pages/AccountPage.tsx')), 'Settings → Account shows a person their own');
const appSrc = read('apps/server/src/app.ts');
const trailCalls = (appSrc.match(/trail\(c, \{ action: '/g) ?? []).length;
check(trailCalls >= 28, `${trailCalls} routes write to the trail`);
check(!/trail\(c, \{[^}]*content/.test(appSrc) && !/trail\(c, \{[^}]*arguments/.test(appSrc) && !/trail\(c, \{[^}]*credential:/.test(appSrc), 'and none of them passes content, arguments or a credential');

/* ------------------------------------------------ 2. the server */

const owner = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
const me = (await req('/auth/me', { cookie: owner })).json.user;
const stamp = Date.now();

const org = (await req('/teams', { method: 'POST', body: { name: `M60 org ${stamp}` }, cookie: owner })).json;
const orgInv = (await req(`/teams/${org.id}/invites`, { method: 'POST', body: {}, cookie: owner })).json;
const bob = await req('/auth/signup', { method: 'POST', body: { token: orgInv.token, email: `m60-bob-${stamp}@example.com`, password: 'password123', displayName: `Bob${stamp}` } });
check(bob.status === 201, 'Bob joins the organization through an invite');
const room = (await req('/sessions', { method: 'POST', body: { title: `M60 room ${stamp}`, teamId: org.id }, cookie: owner })).json;
const base = `/o/${room.ownerSlug}/s/${room.publicId}`;
check((await req(`${base}/members`, { method: 'POST', body: { userId: bob.json.user.id }, cookie: owner })).status === 201, 'the owner adds Bob to a room from the roster');
await req(`${base}/messages`, { method: 'POST', body: { content: `SECRET-${stamp} nobody should see this in the trail` }, cookie: owner });
await req(`${base}/integrations/github/tools/list_issues`, { method: 'PUT', body: { allowed: true }, cookie: owner });
const exp = await req(`${base}/export`, { cookie: owner });
check(exp.status === 200, 'the owner exports the room');
await req(`${base}/pause`, { method: 'POST', cookie: owner });
await req(`${base}/pause`, { method: 'DELETE', cookie: owner });
const inv2 = (await req(`${base}/invites`, { method: 'POST', body: {}, cookie: owner })).json;
await req(`${base}/invites/${inv2.invite.id}/revoke`, { method: 'POST', cookie: owner });
check((await req(`${base}/members/${bob.json.user.id}`, { method: 'DELETE', cookie: owner })).status === 200, 'the owner removes Bob from the room');
await req('/auth/login', { method: 'POST', body: { email: `m60-bob-${stamp}@example.com`, password: 'wrong' } });
check((await req(`/teams/${org.id}/members/${bob.json.user.id}`, { method: 'DELETE', cookie: owner })).status === 200, 'the owner removes Bob from the organization');
await settle();

const trail = (await req(`/teams/${org.id}/audit`, { cookie: owner })).json;
check(Array.isArray(trail?.events) && trail.auditDays === 365 && trail.choices.join() === '90,180,365,730', 'THE OWNER READS THE TRAIL, kept 365 days by default');
const ev = trail.events;
const one = (action, pred = () => true) => ev.filter((e) => e.action === action && pred(e));
check(one('team.created', (e) => e.actor.userId === me.id).length === 1, 'team.created, by the owner');
check(one('invite.created', (e) => e.detail.inviteId === orgInv.invite.id).length === 1, 'invite.created for the organization');
check(one('invite.redeemed', (e) => e.subject?.userId === bob.json.user.id && e.actor.userId === bob.json.user.id).length === 1, 'invite.redeemed, Bob as actor and subject');
check(one('member.added', (e) => e.subject?.userId === bob.json.user.id && e.session?.publicId === room.publicId).length === 1, 'MEMBER.ADDED names Bob and the room');
check(one('grant.changed', (e) => e.detail.slug === 'github' && e.detail.tool === 'list_issues' && e.detail.allowed === true && e.session?.publicId === room.publicId).length === 1, 'grant.changed names the tool and the answer, not the arguments');
check(one('session.exported', (e) => e.actor.userId === me.id && e.session?.publicId === room.publicId).length === 1, 'session.exported, by the owner');
check(one('agents.paused').length === 1 && one('agents.resumed').length === 1, 'agents paused and resumed');
check(one('invite.created', (e) => e.session?.publicId === room.publicId).length === 1 && one('invite.revoked', (e) => e.detail.inviteId === inv2.invite.id).length === 1, 'a room invite created and revoked');
check(one('member.removed', (e) => e.subject?.userId === bob.json.user.id && e.actor.userId === me.id).length === 1, 'member.removed names Bob, by the owner');
check(one('team.member_removed', (e) => e.subject?.userId === bob.json.user.id && e.detail.left === false).length === 1, 'team.member_removed, not a leave');
check(!JSON.stringify(ev).includes(`SECRET-${stamp}`), 'NO EVENT CARRIES MESSAGE CONTENT');
check(ev.every((e) => e.at && e.outcome && e.actor && typeof e.detail === 'object'), 'every event has when, outcome, actor and detail');
check(ev.length >= 2 && new Date(ev[0].at) >= new Date(ev[ev.length - 1].at), 'newest first');

const filtered = (await req(`/teams/${org.id}/audit?action=grant`, { cookie: owner })).json.events;
check(filtered.length === 1 && filtered[0].action === 'grant.changed', 'FILTERED BY KIND: one grant event');
const csv = await req(`/teams/${org.id}/audit?format=csv`, { cookie: owner });
check(csv.status === 200 && csv.type.startsWith('text/csv') && csv.text.startsWith('at,action,outcome,actor,subject,organization,room,ip,detail') && csv.text.includes('member.removed'), 'THE CSV has the header and the rows');
check(!csv.text.includes(`SECRET-${stamp}`), '…and no content either');

// Bob: no organization trail, but his own.
const bobAgain = (await req('/auth/login', { method: 'POST', body: { email: `m60-bob-${stamp}@example.com`, password: 'password123' } })).cookie;
check((await req(`/teams/${org.id}/audit`, { cookie: bobAgain })).status === 404, "A MEMBER (now an outsider) CANNOT READ THE ORGANIZATION'S TRAIL");
await settle();
const mine = (await req('/me/audit', { cookie: bobAgain })).json.events;
check(mine.some((e) => e.action === 'member.removed' && e.subject?.userId === bob.json.user.id && e.actor.name === me.displayName), 'BOB SEES HIS REMOVAL, and who did it');
check(mine.some((e) => e.action === 'login.failed' && e.subject?.userId === bob.json.user.id), '…and the failed sign-in as him');
check(mine.some((e) => e.action === 'login.ok' && e.actor.userId === bob.json.user.id), '…and his own sign-in');
check(!mine.some((e) => e.action === 'session.exported'), "…but not the owner's export, which was not about him");

// Retention: one of four answers, recorded when changed.
check((await req(`/teams/${org.id}/audit-days`, { method: 'PUT', body: { days: 100 }, cookie: owner })).status === 400, 'retention takes only the listed answers');
check((await req(`/teams/${org.id}/audit-days`, { method: 'PUT', body: { days: 90 }, cookie: owner })).json.auditDays === 90, 'the owner shortens it to 90 days');
await settle();
check((await req(`/teams/${org.id}/audit?action=team.audit`, { cookie: owner })).json.events[0]?.detail.days === 90, 'and that is in the trail too');

// The operator reads everything.
const out = execFileSync('pnpm', ['--silent', 'admin', 'audit', '--team', org.id, '--limit', '50'], { encoding: 'utf8' });
check(out.includes('member.removed') && out.includes('session.exported') && !out.includes(`SECRET-${stamp}`), 'ADMIN AUDIT lists the organization, content-free');

// Tidy.
execFileSync('pnpm', ['--silent', 'admin', 'delete-user', '--email', `m60-bob-${stamp}@example.com`, '--now', '--yes'], { stdio: 'ignore' });
await req(base, { method: 'DELETE', cookie: owner });

console.log(failures ? `\n${failures} FAILED` : '\nM60 checks passed');
process.exit(failures ? 1 : 0);
