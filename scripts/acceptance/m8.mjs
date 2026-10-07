/**
 * M8 acceptance: MCP aggregation with per-participant credentials.
 *
 * The property that matters, from ADR 0004: a call goes upstream with the CALLING
 * participant's own credential. The upstream fixture reports which token it saw,
 * so this is proved rather than assumed — a mock that ignored auth could not tell
 * a correct implementation from a confused deputy.
 *
 * Requires: server on :9090, an account, and FABRIKKA_ENCRYPTION_KEY set.
 */
import { execFile as execFileCb, spawn } from 'node:child_process';

const API = 'http://localhost:9090/api';
const MCP = 'http://localhost:9090/mcp';
const UPSTREAM_PORT = 9191;
const UPSTREAM = `http://localhost:${UPSTREAM_PORT}/mcp`;
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';

let failures = 0;
const ok = (m) => console.log('ok  ', m);
const bad = (m) => {
  console.error('FAIL', m);
  failures++;
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

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

async function mcp(url, token, method, params = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = await res.text();
  const payload = body.includes('data: ')
    ? JSON.parse(body.split('data: ').pop())
    : JSON.parse(body);
  return payload;
}

async function tools(url, token) {
  const r = await mcp(url, token, 'tools/list');
  return (r.result?.tools ?? []).map((t) => t.name);
}

async function callTool(url, token, name, args = {}) {
  const r = await mcp(url, token, 'tools/call', { name, arguments: args });
  if (r.error) return { error: r.error.message };
  const text = r.result?.content?.[0]?.text;
  if (r.result?.isError) return { error: text ?? 'tool error' };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { value: text };
  }
}

/* --------------------------------------------- upstream fixture */

const upstream = spawn('node', ['scripts/fixtures/upstream-mcp.mjs', String(UPSTREAM_PORT)], {
  stdio: ['ignore', 'ignore', 'pipe'],
});
await new Promise((r) => setTimeout(r, 2500));

const stamp = Date.now();

/* ------------------------------------------------------------------ setup */

const fede = jar();
if (
  (await req('/auth/login', { method: 'POST', body: { email: EMAIL, password: PASSWORD }, jar: fede }))
    .status !== 200
) {
  console.error(`could not log in as ${EMAIL}`);
  upstream.kill();
  process.exit(1);
}

const S = (
  await req('/sessions', { method: 'POST', body: { title: `Aggregation ${stamp}` }, jar: fede })
).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;
const mcpUrl = `${MCP}/o/${S.ownerSlug}/s/${S.publicId}`;

const fedeAgent = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: 'fede-agent', provider: 'claude-code' },
    jar: fede,
  })
).json;

/* -------------------------------- 1. attaching an integration */

const state = await req(`${base}/integrations`, { jar: fede });
check(state.json.encryptionConfigured === true, 'encryption is configured on this instance');
check(state.json.mine.length === 0, 'no integrations attached yet');

const stdioAttempt = await req(`${base}/integrations`, {
  method: 'POST',
  body: { slug: 'local', url: 'npx -y some-mcp-server' },
  jar: fede,
});
check(
  stdioAttempt.status === 400,
  'A COMMAND IS REFUSED — only http(s) servers are aggregated (ADR 0014)',
);

const FEDE_TOKEN = `fede-upstream-${stamp}`;
const attached = await req(`${base}/integrations`, {
  method: 'POST',
  body: { slug: 'github', label: 'GitHub', url: UPSTREAM, credential: FEDE_TOKEN },
  jar: fede,
});
check(attached.status === 201, 'an http integration attaches');
check(
  attached.json.hasCredential === true &&
    !JSON.stringify(attached.json).includes(FEDE_TOKEN),
  'THE CREDENTIAL IS NEVER RETURNED — only whether one is set',
);

const listed = await req(`${base}/integrations`, { jar: fede });
check(
  !JSON.stringify(listed.json).includes(FEDE_TOKEN),
  'listing integrations never exposes a credential',
);

const discovered = await req(`${base}/integrations/github/tools`, { jar: fede });
check(
  discovered.json.some((t) => t.name === 'list_issues') &&
    discovered.json.some((t) => t.name === 'merge_pull_request'),
  'upstream tools are discovered for the grants UI',
);

/* --------------------------------- 2. default deny */

const beforeGrant = await tools(mcpUrl, fedeAgent.token);
check(
  !beforeGrant.some((t) => t.startsWith('github__')),
  'ATTACHING GRANTS NOTHING — tools are default-deny',
);

await req(`${base}/integrations/github/tools/list_issues`, {
  method: 'PUT',
  body: { allowed: true },
  jar: fede,
});

const afterGrant = await tools(mcpUrl, fedeAgent.token);
check(
  afterGrant.includes('github__list_issues'),
  'a granted tool appears, namespaced by integration',
);
check(
  !afterGrant.includes('github__merge_pull_request'),
  'an UNGRANTED tool stays absent — the merge you never permitted',
);

/* ------------------- 3. the call reaches upstream with the right token */

const called = await callTool(mcpUrl, fedeAgent.token, 'github__list_issues', {
  repo: 'fabrikka',
});
check(called.value?.issues?.length === 2, 'the aggregated call reaches upstream');
check(
  called.value?.seen_token === FEDE_TOKEN,
  "UPSTREAM SAW FEDE'S OWN CREDENTIAL — an agent acts with its owner's token",
);

const denied = await callTool(mcpUrl, fedeAgent.token, 'github__merge_pull_request', {
  number: 1,
});
check(
  !!denied.error,
  'calling an ungranted tool by name is refused, not just hidden from the list',
);

/* --------------- 4. another member sees nothing until they attach */

const aliceEmail = `alice-m8-${stamp}@example.com`;
const inv = await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede });
const alice = jar();
await req('/auth/signup', {
  method: 'POST',
  body: { token: inv.json.token, email: aliceEmail, password: PASSWORD, displayName: 'alice' },
  jar: alice,
});

const aliceAgent = (
  await req(`${base}/agents`, {
    method: 'POST',
    body: { displayName: 'alice-agent', provider: 'claude-code' },
    jar: alice,
  })
).json;

const aliceTools = await tools(mcpUrl, aliceAgent.token);
check(
  !aliceTools.some((t) => t.startsWith('github__')),
  "ALICE'S AGENT SEES NO GITHUB TOOLS — she has attached no credential",
);

const aliceIntegrations = await req(`${base}/integrations`, { jar: alice });
check(
  aliceIntegrations.json.mine.length === 0,
  'alice has no integrations of her own',
);
check(
  aliceIntegrations.json.inSession.some((s) => s.slug === 'github'),
  'she can see the integration EXISTS, so grants are comprehensible',
);

const aliceProbe = await callTool(mcpUrl, aliceAgent.token, 'github__list_issues', {});
check(
  !!aliceProbe.error,
  'calling it by name without attaching is refused',
);

/* --------------- 5. she attaches her own, and upstream sees HERS */

const ALICE_TOKEN = `alice-upstream-${stamp}`;
await req(`${base}/integrations`, {
  method: 'POST',
  body: { slug: 'github', label: 'GitHub', url: UPSTREAM, credential: ALICE_TOKEN },
  jar: alice,
});

const aliceAfter = await tools(mcpUrl, aliceAgent.token);
check(
  aliceAfter.includes('github__list_issues'),
  'after attaching, the granted tool appears for her too',
);

const aliceCall = await callTool(mcpUrl, aliceAgent.token, 'github__list_issues', {});
check(
  aliceCall.value?.seen_token === ALICE_TOKEN,
  "UPSTREAM SAW ALICE'S CREDENTIAL, NOT FEDE'S — no confused deputy",
);

const fedeAgain = await callTool(mcpUrl, fedeAgent.token, 'github__list_issues', {});
check(
  fedeAgain.value?.seen_token === FEDE_TOKEN,
  "and fede's agent still uses fede's — the two do not bleed",
);

/* ------------------------- 6. revoking a grant takes effect */

await req(`${base}/integrations/github/tools/list_issues`, {
  method: 'PUT',
  body: { allowed: false },
  jar: fede,
});

const afterRevoke = await tools(mcpUrl, fedeAgent.token);
check(
  !afterRevoke.includes('github__list_issues'),
  'revoking a grant removes the tool from the list',
);
const afterRevokeCall = await callTool(mcpUrl, fedeAgent.token, 'github__list_issues', {});
check(!!afterRevokeCall.error, 'and the call is refused immediately');

/* ------------------- 7. a member cannot change grants */

await req(`${base}/integrations/github/tools/merge_pull_request`, {
  method: 'PUT',
  body: { allowed: true },
  jar: alice,
});
const aliceGrantAttempt = await tools(mcpUrl, aliceAgent.token);
check(
  !aliceGrantAttempt.includes('github__merge_pull_request'),
  'A NON-OWNER CANNOT GRANT THEMSELVES A TOOL',
);

/* ------------------- 8. detaching removes only your own */

await req(`${base}/integrations/github`, { method: 'DELETE', jar: alice });
const aliceDetached = await tools(mcpUrl, aliceAgent.token);
check(
  !aliceDetached.some((t) => t.startsWith('github__')),
  'detaching removes her access',
);
const fedeStill = await req(`${base}/integrations`, { jar: fede });
check(
  fedeStill.json.mine.some((m) => m.slug === 'github'),
  "and leaves fede's own attachment untouched",
);

/* ------------------- 9. the session's own tools are unaffected */

const sessionTools = await tools(mcpUrl, fedeAgent.token);
check(
  sessionTools.includes('post_message') && sessionTools.includes('read_messages'),
  'aggregation does not disturb the session’s own tools',
);

/* ------- 10. a custom connection signing in with an email + API token (Basic) */

const BASIC_TOKEN = `atl-token-${stamp}`;
const savedBasic = await req('/me/connections', {
  method: 'POST',
  body: { slug: 'basicvendor', url: UPSTREAM, credential: BASIC_TOKEN, username: 'me@example.com' },
  jar: fede,
});
check(savedBasic.status === 201 && !JSON.stringify(savedBasic.json).includes(BASIC_TOKEN), 'an email + API token connection saves, and the token is never returned');
await req(`${base}/integrations`, { method: 'POST', body: { slug: 'basicvendor' }, jar: fede });
await req(`${base}/integrations/basicvendor/tools/whoami`, { method: 'PUT', body: { allowed: true }, jar: fede });
const basicCall = await callTool(mcpUrl, fedeAgent.token, 'basicvendor__whoami', {});
check(
  basicCall.value?.seen_token === `basic:me@example.com:${BASIC_TOKEN}`,
  'IT GOES UPSTREAM AS Basic base64(email:token), the way Atlassian takes a personal API token',
);
const listedBasic = await req('/me/connections', { jar: fede });
check(listedBasic.json.connections.find((c) => c.slug === 'basicvendor')?.auth === 'basic', '…and is listed as an email + API token connection');
check((await req('/me/connections', { method: 'POST', body: { slug: 'basicvendor2', url: UPSTREAM, username: 'x@example.com' }, jar: fede })).status === 400, 'an email without a token is refused');
await req('/me/connections/basicvendor', { method: 'DELETE', jar: fede });

/* ----------------------------------------------------- cleanup */

await req(base, { method: 'DELETE', jar: fede });
await admin(['delete-user', '--email', aliceEmail]).catch(() => {});
upstream.kill();

console.log(
  failures === 0 ? '\nM8 acceptance: PASS' : `\nM8 acceptance: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
