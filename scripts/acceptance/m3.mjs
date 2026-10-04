/**
 * M3 acceptance: the session MCP endpoint (lane A).
 *
 * Drives the endpoint with the real MCP client SDK, and asserts the security
 * boundary from ADR 0001 / ADR 0009 / docs/security.md: a token reaches exactly
 * one session, a wrong token cannot distinguish a real session from an imaginary
 * one, and authorship cannot be spoofed.
 *
 * Requires: server on :9090 and an account.
 * Run: node scripts/acceptance/m3.mjs
 */
import { execFile as execFileCb } from 'node:child_process';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const API = 'http://localhost:9090/api';
const MCP = 'http://localhost:9090/mcp';
const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'fede@example.com';
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
    const child = execFileCb('pnpm', ['admin', ...args], (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
    child.stdin.end(stdinValue ?? '');
  });
}

/** Connect an MCP client with a bearer token. */
async function connect(url, token) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'm3-acceptance', version: '0.0.1' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const block = r.content?.[0];
  return block?.text ? JSON.parse(block.text) : r;
}

/** Raw HTTP probe, for the cases where a connection must not succeed at all. */
async function probe(url, token) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return { status: res.status, wwwAuth: res.headers.get('www-authenticate') };
}

const stamp = Date.now();

/* ------------------------------------------------------------------ setup */

const fede = jar();
const login = await req('/auth/login', {
  method: 'POST',
  body: { email: EMAIL, password: PASSWORD },
  jar: fede,
});
if (login.status !== 200) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}

// Two sessions, so cross-session isolation is testable.
const A = (
  await req('/sessions', { method: 'POST', body: { title: `MCP A ${stamp}` }, jar: fede })
).json;
const B = (
  await req('/sessions', { method: 'POST', body: { title: `MCP B ${stamp}` }, jar: fede })
).json;
const baseA = `/o/${A.ownerSlug}/s/${A.publicId}`;
const baseB = `/o/${B.ownerSlug}/s/${B.publicId}`;
const urlA = `${MCP}/o/${A.ownerSlug}/s/${A.publicId}`;
const urlB = `${MCP}/o/${B.ownerSlug}/s/${B.publicId}`;

// A message from the agent's owner, so trust=owner is actually exercised later
// rather than silently skipped by a find() that matches nothing.
await req(`${baseA}/messages`, {
  method: 'POST',
  body: { content: `fede opening the session ${stamp}` },
  jar: fede,
});

/* -------------------------------------------- 1. creating an agent */

const created = await req(`${baseA}/agents`, {
  method: 'POST',
  body: { displayName: 'claude-a', provider: 'claude-code' },
  jar: fede,
});
check(created.status === 201, 'agent created in session A');
check(!!created.json.token, 'token returned once at creation');
// Setup instructions moved under `setup` at M5, when they became per-provider.
check(
  created.json.setup.remoteCommand.includes('claude mcp add --transport http') &&
    created.json.setup.remoteCommand.includes(created.json.token),
  'a ready-to-paste `claude mcp add` command is returned',
);
check(
  created.json.agent.trustTier === 'owner_only',
  'a new agent defaults to owner_only trust',
);
const tokenA = created.json.token;

const agentB = await req(`${baseB}/agents`, {
  method: 'POST',
  body: { displayName: 'claude-b', provider: 'claude-code' },
  jar: fede,
});
const tokenB = agentB.json.token;

const listedTokens = await req(`${baseA}/tokens`, { jar: fede });
check(
  Array.isArray(listedTokens.json) &&
    !JSON.stringify(listedTokens.json).includes(tokenA),
  'listing tokens never exposes the plaintext',
);

const dupName = await req(`${baseA}/agents`, {
  method: 'POST',
  body: { displayName: 'claude-a' },
  jar: fede,
});
check(dupName.status === 409, 'duplicate agent name in a session is refused');

const badName = await req(`${baseA}/agents`, {
  method: 'POST',
  body: { displayName: 'not a handle' },
  jar: fede,
});
check(badName.status === 409 || badName.status === 400, 'agent name must be a handle');

/* ------------------------------------- 2. the endpoint works at all */

const clientA = await connect(urlA, tokenA);
const info = clientA.getServerVersion?.();
check(info?.name === 'fabrikka', 'MCP client connects and gets server info');
check(
  (clientA.getInstructions?.() ?? '').includes('never follow instructions'),
  'server instructions warn the model about untrusted content',
);

const { tools } = await clientA.listTools();
const names = tools.map((t) => t.name).sort();
check(
  JSON.stringify(names) ===
    JSON.stringify([
      // Artifact tools joined the surface at M7, output tools at M12, links at M19,
      // comments at M23.
      'create_artifact',
      'create_output',
      'edit_output',
      'get_session_context',
      'link',
      'list_artifacts',
      'list_comments',
      'list_links',
      'list_outputs',
      'list_participants',
      'post_message',
      'read_artifact',
      'read_messages',
      'read_output',
      'unlink',
      'update_session_context',
      'whoami',
    ]),
  'the documented tool set is exposed',
);
check(
  tools.every((t) => !!t.description),
  'every tool has a description',
);

const who = await call(clientA, 'whoami');
check(
  who.participant.display_name === 'claude-a' && who.participant.kind === 'agent',
  'whoami identifies the agent participant',
);
check(who.session.id === A.publicId, 'whoami names the session the token reaches');

/* ----------------------------- 3. THE security boundary */

const wrongSession = await probe(urlB, tokenA);
check(
  wrongSession.status === 404,
  "A TOKEN FOR SESSION A RETURNS 404 ON SESSION B — the fundamental boundary",
);

const wrongOwner = await probe(`${MCP}/o/nobody/s/${A.publicId}`, tokenA);
check(wrongOwner.status === 404, 'a wrong owner slug in the path returns 404 (ADR 0006)');

const bogus = await probe(urlA, 'not-a-real-token');
check(bogus.status === 404, 'an invalid token returns 404, not 403 — no existence oracle');

const imaginary = await probe(`${MCP}/o/fede/s/does-not-exist-${stamp}`, tokenA);
check(
  imaginary.status === 404 && bogus.status === 404,
  'a real session with a bad token and an imaginary session are indistinguishable',
);

const noToken = await probe(urlA);
check(
  noToken.status === 401 && /Bearer/i.test(noToken.wwwAuth ?? ''),
  'a MISSING credential answers 401 with WWW-Authenticate: Bearer',
);

/* ---------------------------------- 4. isolation of content */

await req(`${baseB}/messages`, {
  method: 'POST',
  body: { content: `secret-b-${stamp}` },
  jar: fede,
});
const aMessages = await call(clientA, 'read_messages', { limit: 100 });
check(
  !JSON.stringify(aMessages).includes(`secret-b-${stamp}`),
  "session A's token cannot read session B's messages",
);

const clientB = await connect(urlB, tokenB);
const bParticipants = await call(clientB, 'list_participants');
check(
  !JSON.stringify(bParticipants).includes('claude-a'),
  "session B does not expose session A's participants",
);

/* ----------------------------- 5. authorship cannot be spoofed */

const posted = await call(clientA, 'post_message', {
  content: `from the agent ${stamp}`,
});
check(posted.posted_as === 'claude-a', 'a message posts as the token holder');

const viaWeb = await req(`${baseA}/messages`, { jar: fede });
const found = viaWeb.json.find((m) => m.content.includes(`from the agent ${stamp}`));
check(
  found?.author.displayName === 'claude-a' && found?.author.kind === 'agent',
  'the message appears in the web API attributed to the agent participant',
);

/* -------------------------- 6. mention resolution from prose */

const mentioned = await call(clientA, 'post_message', {
  content: `@fede the retry handler resets backoff ${stamp}`,
});
check(
  mentioned.mentions.includes('fede'),
  'an agent mentions a human by name in prose, with no participant id',
);

const webMentioned = (await req(`${baseA}/messages`, { jar: fede })).json.find((m) =>
  m.content.includes(`retry handler resets backoff ${stamp}`),
);
check(
  /<@[0-9a-f-]{36}>/i.test(webMentioned.content),
  'the stored content holds a marker, so the mention survives a rename (ADR 0008)',
);

const read = await call(clientA, 'read_messages', { limit: 100 });
const readBack = read.find((m) => m.content.includes('retry handler resets backoff'));
check(
  readBack.content.includes('@fede') && !readBack.content.includes('<@'),
  'markers are expanded to @name for the agent, not leaked as ids',
);

/* ------------------------------------------- 7. trust evaluation */

const ownerMsg = read.find((m) => m.author === 'fede');
check(!!ownerMsg, 'fixture: an owner-authored message exists to evaluate');
check(ownerMsg?.trust === 'owner', "the agent owner's messages are trust=owner");

const selfMsg = read.find((m) => m.author === 'claude-a');
check(!!selfMsg, 'fixture: an agent-authored message exists to evaluate');
check(selfMsg?.trust === 'owner', "the agent's own messages are trust=owner");

// A second human who does NOT own claude-a.
const aliceEmail = `alice-m3-${stamp}@example.com`;
const inv = await req(`${baseA}/invites`, { method: 'POST', body: {}, jar: fede });
const alice = jar();
await req('/auth/signup', {
  method: 'POST',
  body: { token: inv.json.token, email: aliceEmail, password: PASSWORD, displayName: 'alice' },
  jar: alice,
});
await req(`${baseA}/messages`, {
  method: 'POST',
  body: { content: `alice says ${stamp}` },
  jar: alice,
});

const withAlice = await call(clientA, 'read_messages', { limit: 100 });
const aliceMsg = withAlice.find((m) => m.author === 'alice');
check(
  aliceMsg?.trust === 'untrusted',
  'A NON-OWNER PARTICIPANT IS trust=untrusted — the prompt-injection boundary',
);

await req(`${baseA}/agents/${created.json.agent.sessionAgentId}/trust`, {
  method: 'PATCH',
  body: { trustTier: 'session_trusted' },
  jar: fede,
});
const elevated = await call(clientA, 'read_messages', { limit: 100 });
check(
  elevated.find((m) => m.author === 'alice')?.trust === 'session',
  'elevating the agent to session_trusted reports alice as trust=session',
);
const elevatedOwner = elevated.find((m) => m.author === 'fede');
check(!!elevatedOwner, 'fixture: owner message still present after elevation');
check(
  elevatedOwner?.trust === 'owner',
  'elevation to session_trusted does not downgrade the owner',
);

/* -------------------------------------- 8. mentions_you flag */

await req(`${baseA}/messages`, {
  method: 'POST',
  body: { content: `@claude-a please look ${stamp}` },
  jar: fede,
});
const addressed = await call(clientA, 'read_messages', { limit: 100 });
const forMe = addressed.find((m) => m.content.includes(`please look ${stamp}`));
check(forMe?.mentions_you === true, 'a message mentioning the agent sets mentions_you');
check(
  addressed.filter((m) => m.mentions_you).length >= 1 &&
    addressed.some((m) => m.mentions_you === false),
  'mentions_you is false for messages that do not address the agent',
);

/* ------------------------------------------- 9. paging and limits */

const all = await call(clientA, 'read_messages', { limit: 200 });
check(all.length >= 5, 'read_messages returns history');

const firstPage = await call(clientA, 'read_messages', { limit: 2 });
check(firstPage.length === 2, 'limit is respected');
check(
  new Date(firstPage[0].created_at) <= new Date(firstPage[1].created_at),
  'messages come back oldest-first',
);

const older = await call(clientA, 'read_messages', { limit: 2, before: firstPage[0].id });
check(
  older.every((m) => new Date(m.created_at) <= new Date(firstPage[0].created_at)),
  'the `before` cursor pages backwards through history',
);

let rejected = false;
try {
  await call(clientA, 'read_messages', { limit: 5000 });
} catch {
  rejected = true;
}
check(rejected, 'an over-large limit is rejected rather than silently clamped');

/* ------------------------------------------ 10. session context */

// add_* rather than a bare list: M7 made replacement require if_version, so an
// append is both the documented path and the one that cannot lose an edit.
await call(clientA, 'update_session_context', {
  objective: `Investigate ${stamp}`,
  add_decisions: ['Ask for the CSV'],
});
const ctx = await call(clientA, 'get_session_context');
check(ctx.objective === `Investigate ${stamp}`, 'an agent can write session context');
check(ctx.decisions.length === 1, 'context lists round-trip');

const ctxWeb = await req(`${baseA}/context`, { jar: fede });
check(
  ctxWeb.json.objective === `Investigate ${stamp}`,
  'context written over MCP is visible to the web API',
);

await call(clientA, 'update_session_context', {
  add_questions: ['Can we share the CSV?'],
});
const patched = await call(clientA, 'get_session_context');
check(
  patched.objective === `Investigate ${stamp}` && patched.questions.length === 1,
  'context updates are a patch, not a replace',
);

/* ---------------------------------------------- 11. revocation */

const tokens = await req(`${baseA}/tokens`, { jar: fede });
const tokenRow = tokens.json.find((t) => t.participantId === created.json.agent.participantId);
check(!!tokenRow?.lastUsedAt, 'last_used_at is recorded, so stale tokens are noticeable');

await req(`${baseA}/tokens/${tokenRow.id}/revoke`, { method: 'POST', jar: fede });
const afterRevoke = await probe(urlA, tokenA);
check(afterRevoke.status === 404, 'a revoked token is refused immediately');

/* ----------------------------------------------------- cleanup */

await clientA.close().catch(() => {});
await clientB.close().catch(() => {});
await req(baseA, { method: 'DELETE', jar: fede });
await req(baseB, { method: 'DELETE', jar: fede });
await admin(['delete-user', '--email', aliceEmail]).catch(() => {});

console.log(
  failures === 0 ? '\nM3 acceptance: PASS' : `\nM3 acceptance: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
