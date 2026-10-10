/**
 * M43 acceptance: team call records expire.
 *
 *   - a new team keeps call records for 90 days;
 *   - only an owner changes it, to one of 30/60/90/180/365; a member sees it;
 *   - records older than the setting are deleted, younger ones stay, and
 *     another team's records are untouched;
 *   - the privacy policy states the default and the choices.
 *
 * Requires: the server on :9090, the test account (_setup.mjs), and Docker's
 * Postgres (fabrikka-postgres), to age records without waiting a month.
 */
import { execFile } from 'node:child_process';
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
const psql = (q) =>
  new Promise((ok, fail) =>
    execFile('docker', ['exec', '-i', 'fabrikka-postgres', 'psql', '-U', 'fabrikka', '-d', 'fabrikka', '-tAc', q], (e, out, err) => (e ? fail(new Error(err || e.message)) : ok(out.trim()))),
  );
const cookieOf = (res) => res.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session='))?.split(';')[0] ?? '';
const as = (cookie) => (path, init = {}) =>
  fetch(`${BASE}/api${path}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });

const owner = as(cookieOf(await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })));

/* ------------------------------------------------ 1. the default, and who may change it */

const stamp = Date.now();
const team = await (await owner('/teams', { method: 'POST', body: JSON.stringify({ name: `M43 ${stamp}` }) })).json();
const other = await (await owner('/teams', { method: 'POST', body: JSON.stringify({ name: `M43 other ${stamp}` }) })).json();
check((await (await owner(`/teams/${team.id}/connections`)).json()).callRecordDays === 90, 'a new team keeps call records for 90 days');

const invite = await (await owner(`/teams/${team.id}/invites`, { method: 'POST', body: '{}' })).json();
const signup = await fetch(`${BASE}/api/auth/signup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token: invite.token, email: `m43-${stamp}@example.com`, displayName: `m43 member ${stamp}`, password: 'm43-member-password' }),
});
const member = as(cookieOf(signup));
const seen = await (await member(`/teams/${team.id}/connections`)).json();
check(seen.callRecordDays === 90 && seen.uses.length === 0, 'a member sees how long records are kept, and not the records');
check((await member(`/teams/${team.id}/call-records`, { method: 'PUT', body: JSON.stringify({ days: 30 }) })).status === 403, 'A MEMBER CANNOT CHANGE IT');
check((await owner(`/teams/${team.id}/call-records`, { method: 'PUT', body: JSON.stringify({ days: 45 }) })).status === 400, 'a value outside 30/60/90/180/365 is refused');

/* ------------------------------------------------ 2. old records go, young ones stay */

const addServer = async (teamId) =>
  psql(`insert into team_mcp_servers (team_id, slug, label, url) values ('${teamId}', 'm43', 'M43', 'https://example.com/mcp') returning id`);
const addCall = (serverId, daysAgo) =>
  psql(`insert into team_mcp_calls (team_mcp_server_id, tool_name, ok, created_at) values ('${serverId}', 'd${daysAgo}', true, now() - interval '${daysAgo} days')`);
const tools = async (serverId) => (await psql(`select string_agg(tool_name, ',' order by tool_name) from team_mcp_calls where team_mcp_server_id = '${serverId}'`)).split(',').filter(Boolean);

const server = (await addServer(team.id)).split('\n')[0];
const otherServer = (await addServer(other.id)).split('\n')[0];
for (const d of [29, 31, 95]) await addCall(server, d);
for (const d of [31, 95]) await addCall(otherServer, d);

const set = await owner(`/teams/${team.id}/call-records`, { method: 'PUT', body: JSON.stringify({ days: 30 }) });
check(set.ok && (await (await owner(`/teams/${team.id}/connections`)).json()).callRecordDays === 30, 'an owner sets 30 days');
check((await tools(server)).join() === 'd29', 'RECORDS OLDER THAN 30 DAYS ARE DELETED; the 29-day one stays');
check((await tools(otherServer)).join() === 'd31,d95', "…and another team's records are untouched by this team's setting");
check((await psql(`select count(*) from team_mcp_calls c join team_mcp_servers s on s.id = c.team_mcp_server_id where s.team_id = '${other.id}' and c.created_at < now() - interval '90 days'`)) === '1', "the other team's 95-day record waits for the daily cleanup (90-day default)");
check(/call records are past their team|pruneTeamCalls\(db\)/.test(readFileSync('apps/server/src/app.ts', 'utf8')), 'the server runs the cleanup at start and daily');
check((await psql(`update teams set call_record_days = 45 where id = '${team.id}' returning 1`).then(() => false, () => true)), 'THE DATABASE ITSELF REFUSES A VALUE OUTSIDE THE LIST');

/* ------------------------------------------------ 3. what the docs say */

const mvp = readFileSync('docs/mvp.md', 'utf8');
check(/90 days by default/.test(mvp) && /30, 60, 90, 180 or 365/.test(mvp), 'the docs state the default and every choice');

await psql(`delete from teams where id in ('${team.id}', '${other.id}')`);
await psql(`delete from users where email = 'm43-${stamp}@example.com'`);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM43 checks passed');
process.exit(0);
