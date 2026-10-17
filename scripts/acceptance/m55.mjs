/**
 * M55 acceptance: one-off sessions (ADR 0053).
 *
 * Against the server: a session in Self plus one reusable member invite; the
 * invite preview names the inviter and says it is a one-off session; the
 * person who redeems it is in that session and in no organization of the
 * inviter's; for them it lists as a session whose organization is none of
 * theirs, which the sidebar shows under their own Self; removing them ends
 * it. From the source: the home card in Self only, the sidebar heading, the
 * invite page's wording and app offer.
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

/* ------------------------------------------------ 1. the source */

const home = read('apps/web/src/pages/HomePage.tsx');
check(/\{team\?\.own && <OneOffBar onMade=\{load\} \/>\}/.test(home) && /Start a one-off session/.test(home), 'THE SELF HOME HAS THE ONE-OFF SESSION BAR, and only Self');
check(/const s = await sessions\.create\(title\.trim\(\), undefined, 'private'\);[\s\S]{0,200}const inv = await sessions\.createInvite\(\{ owner: s\.ownerSlug, session: s\.publicId \}, \{ reusable: true \}\);/.test(home), 'one click: a private session in your own organization, then ONE REUSABLE INVITE (ADR 0053 amended 2026-10-17)');
check(/inv\.uses > 0 \? `\$\{inv\.uses\} joined · ` : ''/.test(home), 'the home shows how many joined through each open link');
check(/Copied ✓/.test(home) && /Open the session/.test(home), 'the link to copy, then the room');
const side = read('apps/web/src/shell/Sidebar.tsx');
check(/aria-label="One-off sessions"/.test(side) && /team\.own && \(/.test(side) && /navigate\('\/\?one-off=1'\)/.test(side), 'in Self the first heading is One-off sessions, and its + lands on the card');
check(/!teams\.some\(\(t\) => t\.id === s\.team!\.id\)/.test(side), "SESSIONS WHOSE ORGANIZATION IS NONE OF YOURS LIST UNDER YOUR SELF: the other side of a one-off session");
check(/else if \(own && own\.id !== team\?\.id\) selectTeam\(own\.id\)/.test(read('apps/web/src/shell/AppShell.tsx')), 'opening one from a link selects your Self');
const invite = read('apps/web/src/pages/InvitePage.tsx');
check(/invited you to a one-off session: “\$\{preview\.title\}”/.test(invite) && /You join this session, nothing else/.test(invite), 'the invite page says who and what');
check(/<a href=\{app\.appUrl\}>Get the app<\/a>/.test(invite), '…and offers the app when the instance serves one');

/* ------------------------------------------------ 2. the server */

const fede = (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD } })).cookie;
const me = (await req('/auth/me', { cookie: fede })).json.user;
const own = (await req('/teams', { cookie: fede })).json.find((t) => t.own);
const stamp = Date.now();
const S = (await req('/sessions', { method: 'POST', body: { title: `One-off ${stamp}`, visibility: 'private' }, cookie: fede })).json;
check(S.team?.id === own.id && S.individual === true, 'the session is in Self, individual until someone joins');
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const inv = (await req(`${base}/invites`, { method: 'POST', body: { reusable: true }, cookie: fede })).json;
check(inv.invite.maxUses === null && inv.invite.uses === 0, 'THE ONE-OFF LINK IS REUSABLE: no limit on how many join through it');
const preview = (await req(`/invites/${inv.token}`)).json;
check(preview?.kind === 'session' && preview.oneOff === true && preview.inviter === me.displayName && preview.guest === false, 'THE INVITE PREVIEW SAYS: a one-off session, from whom, to take part');

const other = (await req('/sessions', { method: 'POST', body: { title: `Org ${stamp}`, teamId: (await req('/teams', { method: 'POST', body: { name: `Org ${stamp}` }, cookie: fede })).json.id }, cookie: fede })).json;
const inv2 = (await req(`/o/${other.ownerSlug}/s/${other.publicId}/invites`, { method: 'POST', body: {}, cookie: fede })).json;
check((await req(`/invites/${inv2.token}`)).json.oneOff === false, "a session in another organization is not a one-off session");

const pat = await req('/auth/signup', { method: 'POST', body: { token: inv.token, email: `m55-pat-${stamp}@example.com`, password: 'password123', displayName: `Pat ${stamp}` } });
check(pat.status === 201, 'Pat makes an account through the link');
const patTeams = (await req('/teams', { cookie: pat.cookie })).json;
check(patTeams.length === 1 && patTeams[0].own && patTeams[0].name === 'Self', 'PAT IS IN NO ORGANIZATION OF FEDE\'S: only their own Self');
const patSessions = (await req('/sessions', { cookie: pat.cookie })).json;
const forPat = patSessions.find((s) => s.publicId === S.publicId);
check(forPat && forPat.team?.id === own.id && !patTeams.some((t) => t.id === forPat.team.id), "…and sees the session, whose organization is Fede's Self, not theirs");
check((await req(base, { cookie: pat.cookie })).json?.me?.role === 'member', 'Pat takes part: a member, not a guest');
const forFede = (await req('/sessions', { cookie: fede })).json.find((s) => s.publicId === S.publicId);
check(forFede.individual === false && forFede.memberCount === 2, 'for Fede it is no longer individual: a one-off session');
check((await req(`/invites/${inv.token}`)).status === 200, 'THE LINK STILL WORKS after Pat: it is for everyone who should be in');
const sam = await req('/auth/signup', { method: 'POST', body: { token: inv.token, email: `m55-sam-${stamp}@example.com`, password: 'password123', displayName: `Sam ${stamp}` } });
check(sam.status === 201 && (await req(base, { cookie: sam.cookie })).json?.me?.role === 'member', 'Sam joins through the same link');
check((await req('/sessions', { cookie: fede })).json.find((s) => s.publicId === S.publicId).memberCount === 3, 'three people in the one-off session');
const again = await req(`/invites/${inv.token}/redeem`, { method: 'POST', cookie: pat.cookie });
check(again.status === 200 && again.json.session?.publicId === S.publicId, 'Pat opens the link again: the room, nothing claimed');
const listed = (await req(`${base}/invites`, { cookie: fede })).json.find((i) => i.id === inv.invite.id);
check(listed.uses === 2 && listed.redeemedAt === null, 'two joined, and the link is still open');
const homeOpen = (await req('/me/home', { cookie: fede })).json.openInvites.find((i) => i.id === inv.invite.id);
check(homeOpen && homeOpen.uses === 2, 'THE HOME LISTS IT UNDER OPEN LINKS with how many joined');
check((await req(`/invites/${inv2.token}`)).status === 200 && inv2.invite.maxUses === 1, 'an ordinary invite is still single-use…');
const guestInv = (await req(`${base}/invites`, { method: 'POST', body: { reusable: true, role: 'guest' }, cookie: fede })).json;
check(guestInv.invite.maxUses === 1, '…and a guest invite is never reusable, even if asked');
check((await req(`${base}/invites/${inv.invite.id}/revoke`, { method: 'POST', cookie: fede })).status === 200 && (await req(`/invites/${inv.token}`)).status === 404, 'REVOKED, the link says it can\'t be used');

await req(`${base}/members/${pat.json.user.id}`, { method: 'DELETE', cookie: fede });
await req(`${base}/members/${sam.json.user.id}`, { method: 'DELETE', cookie: fede });
check((await req(base, { cookie: pat.cookie })).status === 404, 'removed from the session, Pat has nothing left');
check((await req('/sessions', { cookie: fede })).json.find((s) => s.publicId === S.publicId).individual === true, '…and for Fede it is individual again');

console.log(failures ? `\n${failures} FAILED` : '\nM55 checks passed');
process.exit(failures ? 1 : 0);
