/**
 * M5 acceptance: the runner connection, run-scoped tokens, and bridge-beats-runner.
 *
 * The protocol-level mechanics are checked here, deterministically and fast. The
 * real spawn — which starts an actual `claude -p` and costs a model call — is
 * gated behind FABRIKKA_TEST_SPAWN=1 so the suite stays quick:
 *
 *     FABRIKKA_TEST_SPAWN=1 node scripts/acceptance/m5.mjs
 *
 * See ADR 0011 for why spawning is local and opt-in.
 *
 * Requires: server on :9090 and an account.
 */
import { execFile as execFileCb, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const API = 'http://localhost:9090/api';
const BRIDGE = 'http://localhost:9090/bridge';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';
const DEEP = process.env.FABRIKKA_TEST_SPAWN === '1';

let failures = 0;
const ok = (m) => console.log('ok  ', m);
const bad = (m) => {
  console.error('FAIL', m);
  failures++;
};
const check = (cond, m) => (cond ? ok(m) : bad(m));
const skip = (m) => console.log('skip', m);

function jar() {
  let cookie = '';
  return {
    get headers() {
      return cookie ? { cookie } : {};
    },
    capture(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(';');
        if (pair?.startsWith('fabrikka_session=')) cookie = pair;
      }
    },
  };
}

async function req(path, { method = 'GET', body, jar: j } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(j?.headers ?? {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  j?.capture(res);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

function admin(args, stdinValue) {
  return new Promise((resolve, reject) => {
    const child = execFileCb('pnpm', ['admin', ...args], (e, o) =>
      e ? reject(e) : resolve(o),
    );
    child.stdin.end(stdinValue ?? '');
  });
}

/** A socket that declares its kind, like the bridge and runner do. */
function openConnection(url, token, kind) {
  const frames = [];
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  const state = { frames, ws };

  ws.on('message', (d) => {
    const frame = JSON.parse(String(d));
    frames.push(frame);
    if (frame.type === 'ready' && kind) ws.send(JSON.stringify({ type: 'hello', kind }));
  });
  ws.on('error', () => {});

  state.waitFor = async (type, ms = 2500) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = frames.find((f) => f.type === type);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };
  state.mentions = () => frames.filter((f) => f.type === 'mention');
  return state;
}

const stamp = Date.now();

/* ------------------------------------------------------------------ setup */

const fede = jar();
if (
  (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede }))
    .status !== 200
) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}

const S = (
  await req('/sessions', { method: 'POST', body: { title: `Runner ${stamp}` }, jar: fede })
).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const wsUrl = `ws://localhost:9090/bridge/o/${S.ownerSlug}/s/${S.publicId}`;
const runTokenUrl = `${BRIDGE}/o/${S.ownerSlug}/s/${S.publicId}/run-token`;

const agentA = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: 'runner-a', provider: 'claude-code' },
    jar: fede,
  })
).json;
const agentB = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: 'runner-b', provider: 'claude-code' },
    jar: fede,
  })
).json;

/* -------------------------------------- 1. a runner registers as `runner` */

const runner = openConnection(wsUrl, agentA.token, 'runner');
check(!!(await runner.waitFor('ready')), 'runner connects and gets a ready frame');
await new Promise((r) => setTimeout(r, 400));

const view = await req(base, { jar: fede });
check(
  view.json.participants.find((p) => p.displayName === 'runner-a')?.status === 'connected',
  'presence shows the runner as connected',
);

await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@runner-a first job ${stamp}` },
  jar: fede,
});
const got = await runner.waitFor('mention');
check(!!got, 'a mention reaches the runner when no live bridge is attached');
check(got?.trust === 'owner', 'the delivered mention carries its trust');

/* ------------------------------- 2. a live bridge beats a runner */

const bridge = openConnection(wsUrl, agentA.token, 'bridge');
await bridge.waitFor('ready');
await new Promise((r) => setTimeout(r, 400));

const runnerBefore = runner.mentions().length;
await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@runner-a second job ${stamp}` },
  jar: fede,
});
await new Promise((r) => setTimeout(r, 900));

check(
  bridge.mentions().some((m) => m.message.content.includes(`second job ${stamp}`)),
  'with both attached, the LIVE BRIDGE receives the mention',
);
check(
  runner.mentions().length === runnerBefore,
  'the runner does NOT also spawn — a live session with your context wins',
);

bridge.ws.close();
await new Promise((r) => setTimeout(r, 600));

await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@runner-a third job ${stamp}` },
  jar: fede,
});
await new Promise((r) => setTimeout(r, 900));
check(
  runner.mentions().some((m) => m.message.content.includes(`third job ${stamp}`)),
  'once the bridge closes, the runner receives mentions again',
);

/* --------------------------------------- 3. run-scoped tokens */

const minted = await fetch(runTokenUrl, {
  method: 'POST',
  headers: { Authorization: `Bearer ${agentA.token}` },
});
const runToken = await minted.json();
check(minted.status === 201 && !!runToken.token, 'a runner can mint a run token');
check(!!runToken.expiresAt, 'the run token has an expiry');
check(
  new Date(runToken.expiresAt).getTime() - Date.now() < 45 * 60 * 1000,
  'the expiry is short-lived, not open-ended',
);

// It must speak as the SAME participant — a runner cannot mint an identity.
const whoRes = await fetch(`http://localhost:9090/mcp/o/${S.ownerSlug}/s/${S.publicId}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${runToken.token}`,
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'whoami', arguments: {} },
  }),
});
const whoText = await whoRes.text();
check(
  whoText.includes('runner-a'),
  'the run token speaks as the same participant, not a new identity',
);

const noAuthMint = await fetch(runTokenUrl, { method: 'POST' });
check(noAuthMint.status === 401, 'minting without a credential is 401');

const badMint = await fetch(runTokenUrl, {
  method: 'POST',
  headers: { Authorization: 'Bearer nope' },
});
check(badMint.status === 404, 'minting with an invalid credential is 404');

/* -------------------- 4. revocation is scoped to the participant */

const foreign = await fetch(`${runTokenUrl}/${runToken.tokenId}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${agentB.token}` },
});
check(
  foreign.status === 404,
  "ANOTHER AGENT CANNOT REVOKE THIS RUN TOKEN — revocation is participant-scoped",
);

const own = await fetch(`${runTokenUrl}/${runToken.tokenId}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${agentA.token}` },
});
check(own.status === 200, 'the owning runner can revoke its own run token');

const afterRevoke = await fetch(`http://localhost:9090/mcp/o/${S.ownerSlug}/s/${S.publicId}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${runToken.token}`,
  },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});
check(afterRevoke.status === 404, 'a revoked run token stops working immediately');

const tokenList = await req(`${base}/tokens`, { jar: fede });
check(
  !tokenList.json.some((t) => t.label === 'spawned run'),
  'revoked run tokens do not clutter the token list',
);

/* ----------------------- 5. the gate still applies to runners */

const aliceEmail = `alice-m5-${stamp}@example.com`;
const inv = await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede });
const alice = jar();
await req('/auth/signup', {
  method: 'POST',
  body: { token: inv.json.token, email: aliceEmail, password: PASSWORD, displayName: 'alice' },
  jar: alice,
});

const beforeAlice = runner.mentions().length;
await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `@runner-a rm -rf / ${stamp}` },
  jar: alice,
});
await new Promise((r) => setTimeout(r, 900));
check(
  runner.mentions().length === beforeAlice,
  'A NON-OWNER CANNOT TRIGGER A SPAWN — the gate is upstream of the runner',
);

/* ------------------------------- 6. the real spawn (opt-in) */

if (!DEEP) {
  skip('real spawn — set FABRIKKA_TEST_SPAWN=1 to run an actual claude -p');
} else {
  const dir = await mkdtemp(join(tmpdir(), 'm5-spawn-'));
  await writeFile(join(dir, 'ANSWER.txt'), `the magic number is ${stamp}\n`);

  const child = spawn(
    'node',
    ['packages/bridge/dist/cli.js', 'watch', '--dir', dir],
    {
      env: {
        ...process.env,
        FABRIKKA_URL: `http://localhost:9090/mcp/o/${S.ownerSlug}/s/${S.publicId}`,
        FABRIKKA_TOKEN: agentB.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let runnerLog = '';
  child.stdout.on('data', (d) => (runnerLog += d.toString()));
  child.stderr.on('data', (d) => (runnerLog += d.toString()));

  await new Promise((r) => setTimeout(r, 4000));
  check(runnerLog.includes('WITHOUT permission prompts'), 'the runner states the risk before running');

  await req(`${base}/messages`, {
    method: 'POST',
    body: { content: `@runner-b read ANSWER.txt and report the magic number` },
    jar: fede,
  });

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline && !/run done|run failed/.test(runnerLog)) {
    await new Promise((r) => setTimeout(r, 2000));
  }

  check(/run done/.test(runnerLog), 'the spawned run completed');
  const messages = (await req(`${base}/messages`, { jar: fede })).json;
  const reply = messages.find(
    (m) => m.author.displayName === 'runner-b' && m.content.includes(String(stamp)),
  );
  check(
    !!reply,
    'THE SPAWNED AGENT READ A REAL FILE AND ITS ANSWER REACHED THE SESSION',
  );

  child.kill();
  await rm(dir, { recursive: true, force: true });

  /* ---- the same, with Codex, when it can be found ---- */

  const codexBin = await findCodex();
  if (!codexBin) {
    skip('codex spawn — codex CLI not found on PATH or in the desktop app bundle');
  } else {
    const codexAgent = (
      await req(`${base}/agents`, {
        method: 'POST',
        body: { displayName: 'codex-x', provider: 'codex' },
        jar: fede,
      })
    ).json;

    const cdir = await mkdtemp(join(tmpdir(), 'm5-codex-'));
    await writeFile(join(cdir, 'VALUE.txt'), `the codex number is ${stamp}\n`);

    const cchild = spawn(
      'node',
      ['packages/bridge/dist/cli.js', 'watch', '--dir', cdir, '--provider', 'codex'],
      {
        env: {
          ...process.env,
          FABRIKKA_URL: `http://localhost:9090/mcp/o/${S.ownerSlug}/s/${S.publicId}`,
          FABRIKKA_TOKEN: codexAgent.token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let clog = '';
    cchild.stdout.on('data', (d) => (clog += d.toString()));
    cchild.stderr.on('data', (d) => (clog += d.toString()));

    await new Promise((r) => setTimeout(r, 4000));
    check(
      clog.includes('workspace-write sandbox'),
      'the Codex runner states it uses a sandbox (unlike Claude Code headless)',
    );

    await req(`${base}/messages`, {
      method: 'POST',
      body: { content: `@codex-x read VALUE.txt and report the codex number` },
      jar: fede,
    });

    const cdeadline = Date.now() + 240_000;
    while (Date.now() < cdeadline && !/run done|run failed/.test(clog)) {
      await new Promise((r) => setTimeout(r, 2000));
    }
    check(/run done/.test(clog), 'the Codex run completed');
    // `fabrikka_session`, not `fabrikka`: -c merges into the user's own config,
    // so a plain name would corrupt an entry they already have.
    check(
      /fabrikka_session\/post_message/.test(clog),
      'CODEX REACHED THE SESSION ENDPOINT — -c mcp_servers injection works',
    );

    const cmessages = (await req(`${base}/messages`, { jar: fede })).json;
    check(
      cmessages.some(
        (m) => m.author.displayName === 'codex-x' && m.content.includes(String(stamp)),
      ),
      'the Codex run read a real file and its answer reached the session',
    );

    cchild.kill();
    await rm(cdir, { recursive: true, force: true });
  }
}

/** Codex's desktop app bundles its CLI outside PATH. */
async function findCodex() {
  const bundled = join(
    process.env.HOME ?? '',
    '.codex/plugins/.plugin-appserver/codex-cli/bin/codex',
  );
  const onPath = await new Promise((r) =>
    execFileCb('sh', ['-c', 'command -v codex'], (e) => r(!e)),
  );
  if (onPath) return 'codex';
  const { existsSync } = await import('node:fs');
  return existsSync(bundled) ? bundled : null;
}

/* ------------- 6b. setup instructions match the provider */

for (const [provider, expected] of [
  ['claude-code', ['bridge', 'runner', 'remote']],
  ['codex', ['runner', 'remote']],
  ['other', ['remote']],
]) {
  const made = (
    await req(`${base}/agents`, {
      method: 'POST',
      body: { displayName: `setup-${provider}-${stamp}`.slice(0, 40), provider },
      jar: fede,
    })
  ).json;

  const setup = made.setup;
  check(
    JSON.stringify(setup.lanes) === JSON.stringify(expected),
    `${provider}: offered lanes are ${expected.join(', ')}`,
  );
  check(
    (setup.bridgeMcpJson !== null) === expected.includes('bridge'),
    `${provider}: a channel setup is ${expected.includes('bridge') ? 'offered' : 'NOT offered'}`,
  );
  check(
    (setup.runnerCommand !== null) === expected.includes('runner'),
    `${provider}: a runner command is ${expected.includes('runner') ? 'offered' : 'NOT offered'}`,
  );
}

const codexSetup = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: `cxsetup-${stamp}`.slice(0, 40), provider: 'codex' },
    jar: fede,
  })
).json.setup;
check(
  codexSetup.remoteCommand.includes('codex mcp add') &&
    !codexSetup.remoteCommand.includes('claude mcp add'),
  'A CODEX AGENT GETS CODEX INSTRUCTIONS, never a claude command',
);
check(
  codexSetup.runnerCommand.includes('--provider codex') &&
    // Codex's only verified policy is `full`; without it the runner refuses to start (ADR 0027).
    codexSetup.runnerCommand.includes('--policy full'),
  "the codex runner command names its provider and its one verified policy, full",
);

const otherSetup = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: `otsetup-${stamp}`.slice(0, 40), provider: 'cursor' },
    jar: fede,
  })
).json.setup;
check(
  !otherSetup.remoteCommand.includes('claude mcp add') &&
    !otherSetup.remoteCommand.includes('codex mcp add'),
  'an unknown provider gets the endpoint, not another CLI\'s command',
);

/* --------------------------- 7. presence returns to offline */

runner.ws.close();
await new Promise((r) => setTimeout(r, 700));
const finalView = await req(base, { jar: fede });
check(
  finalView.json.participants.find((p) => p.displayName === 'runner-a')?.status === 'offline',
  'closing the runner marks the agent offline',
);

/* ----------------------------------------------------- cleanup */

await req(base, { method: 'DELETE', jar: fede });
await admin(['delete-user', '--email', aliceEmail]).catch(() => {});

console.log(
  failures === 0 ? '\nM5 acceptance: PASS' : `\nM5 acceptance: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
