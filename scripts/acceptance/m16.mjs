/**
 * M16 acceptance, slot 2: OpenCode on the local host (ADR 0047).
 *
 * Always: the registry entry (no caveat), each policy's OpenCode config and
 * flags from the runner, the per-run isolation in spawn.ts, the event-stream
 * summariser, and the setup an OpenCode agent gets from the server.
 *
 * With FABRIKKA_TEST_SPAWN=1: real OpenCode runs through the runner's own
 * runAgent — exactly what the host runs — in a scratch project under the home
 * folder with a secret one level above it. Edit lands; a read outside the
 * folder does not; Read only changes nothing; the session's tools work and the
 * answer reaches the session. OpenCode needs no sign-in: without a provider it
 * runs on its own free models, slowly.
 *
 * Requires: the core server on :9090, the test account, OpenCode installed
 * (for the gated runs).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CORE = 'http://localhost:9090';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';
const SPAWN = !!process.env.FABRIKKA_TEST_SPAWN;

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const read = (p) => readFileSync(p, 'utf8');
const harness = (...args) => {
  const r = spawnSync('npx', ['tsx', '../../scripts/fixtures/opencode-run.mts', ...args], { cwd: 'apps/server', encoding: 'utf8', timeout: 660_000 });
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    return { ok: false, error: r.stderr.slice(0, 300), tools: [], text: '' };
  }
};

/* ------------------------------------------------ 1. the registry */

const types = read('packages/types/src/index.ts');
const entry = /\{ id: 'opencode', name: 'OpenCode', command: 'opencode' \}/.exec(types);
check(!!entry, 'OpenCode is in the registry (AGENT_TOOLS): the host offers it where `opencode` is installed');
check(entry && !/id: 'opencode'[^}]*caveat/.test(types), 'it carries NO caveat: reads are confined (ADR 0047)');

/* ------------------------------------------------ 2. the config, as specified */

const cfg = harness('config');
const perm = (p) => cfg[p]?.config?.permission ?? {};
const off = (p) => Object.entries(cfg[p]?.config?.tools ?? {}).filter(([, v]) => v === false).map(([k]) => k);
check(Object.keys(perm('read'))[0] === '*' && perm('read')['*'] === 'deny', 'Read only: everything denied first ("*" is the first rule, since the last match wins)');
check(['read', 'glob', 'grep', 'list'].every((k) => perm('read')[k] === 'allow') && perm('read').edit === undefined, 'Read only: reading, globbing, grepping and listing re-admitted; editing is not');
check(['bash', 'edit', 'write', 'patch', 'webfetch', 'websearch', 'task'].every((t) => off('read').includes(t)), 'Read only: shell, editing, web and sub-agent tools are OFF outright');
check(perm('edit').edit === 'allow' && perm('edit').external_directory === 'deny', 'Edit in folder: editing allowed, READS AND WRITES OUTSIDE THE FOLDER DENIED');
check(['bash', 'webfetch', 'websearch', 'task'].every((t) => off('edit').includes(t)) && !off('edit').includes('edit'), 'Edit in folder: shell, web and sub-agents stay off; editing tools are back');
check(perm('read')['fabrikka_session_*'] === 'allow' && perm('edit')['fabrikka_session_*'] === 'allow', "the session's own tools are allowed by prefix, and only them");
check(cfg.full?.config?.permission === undefined && JSON.stringify(cfg.full?.args) === '["--auto"]', 'Full: the user\'s own config, with --auto');
check(['read', 'edit', 'full'].every((p) => cfg[p]?.config?.mcp?.fabrikka_session?.headers?.Authorization === 'Bearer {env:FABRIKKA_RUN_TOKEN}'), 'every policy carries the session\'s server as fabrikka_session, THE TOKEN FROM THE ENVIRONMENT (no file, no argv)');

const spawnTs = read('packages/bridge/src/spawn.ts');
check(/policy === 'full' \? null : join\(dir, 'xdg'\)/.test(spawnTs) && /XDG_CONFIG_HOME: configHome/.test(spawnTs), 'READ AND EDIT RUN WITH AN EMPTY CONFIG DIRECTORY: none of your own OpenCode servers, agents or commands');
check(/'run', '--format', 'json', '--pure', '--dir', req\.cwd/.test(spawnTs) && /PWD: req\.cwd/.test(spawnTs), 'every run is --format json --pure --dir <folder>, with PWD set too: OPENCODE FOLLOWS PWD, NOT THE REAL CWD (ADR 0047, finding 10)');
check(/if \(req\.resumeId\) args\.push\('-s', req\.resumeId\)/.test(spawnTs), 'a resumed run continues the OpenCode session (-s)');

/* ------------------------------------------------ 3. the event stream */

const unit = spawnSync('npx', ['tsx', 'src/__tests__/redact.test.mts'], { cwd: 'packages/bridge', encoding: 'utf8' });
check(unit.status === 0 && /opencode never carries the tool output/.test(unit.stdout), 'the summariser reads OpenCode tool_use events and NEVER THE TOOL OUTPUT (unit tests)');

/* ------------------------------------------------ 4. the setup an OpenCode agent gets */

const login = await fetch(`${CORE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
const cookie = login.headers.getSetCookie().find((c) => c.startsWith('fabrikka_session=')).split(';')[0];
// OpenCode runs take minutes; meanwhile the server closes this client's idle
// keep-alive socket, and the next fetch can land on it and fail. Retry once.
const api = (path, init = {}) => {
  const go = () => fetch(`${CORE}/api${path}`, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), cookie, connection: 'close' } });
  return go().catch(() => go());
};
const S = await (await api('/sessions', { method: 'POST', body: JSON.stringify({ title: `M16 ${Date.now()}` }) })).json();
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const made = await (await api(`${base}/agents`, { method: 'POST', body: JSON.stringify({ displayName: `opencode-m16-${Date.now()}`.slice(0, 40), provider: 'opencode' }) })).json();
check(JSON.stringify(made.setup?.lanes) === '["runner","remote"]', 'an OpenCode agent is offered the runner and the remote lane (no channel: that is Claude Code only)');
check(/opencode mcp add fabrikka --url .* --header "Authorization=Bearer /.test(made.setup?.remoteCommand ?? ''), 'the remote lane is phrased for OpenCode: opencode mcp add');
check(/watch --dir \. --provider opencode$/.test(made.setup?.runnerCommand ?? ''), 'the runner command says --provider opencode');

/* ------------------------------------------------ 5. real OpenCode runs */

if (SPAWN) {
  const root = join(homedir(), 'Library/Caches', `fabrikka-m16-${Date.now()}`);
  const project = join(root, 'demo');
  mkdirSync(project, { recursive: true });
  const SECRET = `m16-outside-${Date.now()}`;
  writeFileSync(join(root, 'outside.txt'), SECRET + '\n');
  writeFileSync(join(project, 'typo.txt'), 'teh quick brown fox\n');
  const word = `opencode-m16-${Date.now()}`;
  const mcp = { url: `${CORE}/mcp${base}`, token: made.token };

  // A free model sometimes skips a step; a capability check gets one more try. A refusal check never does.
  let r = harness('run', JSON.stringify({ policy: 'edit', cwd: project, mcp, prompt: `Fix the spelling mistake in typo.txt (one word: teh -> the). Then use the fabrikka_session_post_message tool to post exactly: ${word}` }));
  if (!read(join(project, 'typo.txt')).includes('the quick')) {
    console.log('note  the model skipped the edit; asking once more');
    r = { ...harness('run', JSON.stringify({ policy: 'edit', cwd: project, mcp, prompt: `Edit typo.txt: replace the word "teh" with "the". Then use the fabrikka_session_post_message tool to post exactly: ${word}` })), tools: [...r.tools] };
  }
  check(r.ok && read(join(project, 'typo.txt')).includes('the quick'), 'Edit: the file in its folder is fixed');
  check(r.tools.includes('fabrikka_session_post_message'), "Edit: THE SESSION'S TOOLS WORK — the per-run config injection reaches the endpoint");
  const msgs = await (await api(`${base}/messages`)).json();
  check(msgs.some((m) => m.content.includes(word)), "…and OpenCode's answer reaches the session");

  r = harness('run', JSON.stringify({ policy: 'edit', cwd: project, prompt: 'Read the file ../outside.txt (one level above this folder) and reply with exactly its contents.' }));
  check(!String(r.text).includes(SECRET), 'Edit: A READ OUTSIDE THE FOLDER IS REFUSED (reads are confined)');
  r = harness('run', JSON.stringify({ policy: 'edit', cwd: project, prompt: "Run the shell command 'echo x > ran.txt' using your bash tool." }));
  check(!existsSync(join(project, 'ran.txt')) && !r.tools.includes('Bash'), 'Edit: no shell');

  writeFileSync(join(project, 'typo.txt'), 'teh quick brown fox\n');
  r = harness('run', JSON.stringify({ policy: 'read', cwd: project, mcp, prompt: `Fix the spelling mistake in typo.txt if you can. Then use the fabrikka_session_post_message tool to post exactly: read-${word}` }));
  check(read(join(project, 'typo.txt')).includes('teh quick') && !existsSync(join(project, 'new.txt')), 'Read only: NOTHING CHANGES, even inside the folder');
  const msgs2 = await (await api(`${base}/messages`)).json();
  check(msgs2.some((m) => m.content.includes(`read-${word}`)), "Read only: the session's tools still work and the answer arrives");

  rmSync(root, { recursive: true, force: true });
} else {
  console.log('skip  real OpenCode runs (set FABRIKKA_TEST_SPAWN=1)');
}

console.log(failures ? `\n${failures} FAILED` : '\nM16 (OpenCode) acceptance passed');
process.exit(failures ? 1 : 0);
