/**
 * M2 acceptance: mentions as first-class objects.
 *
 * The properties from ADR 0008: content stores stable markers, mention rows are
 * derived from them, renames are correct retroactively, prose from agents
 * resolves without ids, and a cross-session mention is refused rather than
 * dropped.
 *
 * Requires: server on :9090, an account, and the demo session.
 * Run: node scripts/acceptance/m2.mjs
 */
import { execFile as execFileCb } from 'node:child_process';

const API = 'http://localhost:9090/api';
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

const MARKER = /<@([0-9a-f-]{36})>/gi;
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

const s = (
  await req('/sessions', {
    method: 'POST',
    body: { title: `Mentions check ${stamp}` },
    jar: fede,
  })
).json;
const base = `/o/${s.ownerSlug}/s/${s.publicId}`;

// A second human, so there is someone to mention who isn't the author.
const aliceEmail = `alice-m2-${stamp}@example.com`;
const invite = await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede });
const alice = jar();
await req('/auth/signup', {
  method: 'POST',
  body: {
    token: invite.json.token,
    email: aliceEmail,
    password: PASSWORD,
    displayName: 'alice',
  },
  jar: alice,
});

const participants = (await req(`${base}/participants`, { jar: fede })).json;
const aliceP = participants.find((p) => p.displayName === 'alice');
const fedeP = participants.find((p) => p.displayName !== 'alice');
check(!!aliceP && !!fedeP, 'session has both participants');

/* -------------------------------------- 1. composer path: explicit id */

const composed = await req(`${base}/messages`, {
  method: 'POST',
  body: { content: 'hey @alice can you look at this', mentions: [aliceP.id] },
  jar: fede,
});
check(composed.status === 201, 'message with an explicit mention accepted');
check(
  composed.json.content === `hey <@${aliceP.id}> can you look at this`,
  'content stored as a marker, not the literal name',
);
check(
  !composed.json.content.includes('@alice'),
  'stored content contains no display name at all',
);
check(
  composed.json.mentions.length === 1 &&
    composed.json.mentions[0].participantId === aliceP.id &&
    composed.json.mentions[0].displayName === 'alice',
  'mention resolved with display name and id',
);

/* ------------------------------ 2. agent path: bare prose, no ids */

const prose = await req(`${base}/messages`, {
  method: 'POST',
  body: { content: 'I reviewed it, @alice — three commits look relevant.' },
  jar: fede,
});
check(
  [...prose.json.content.matchAll(MARKER)].length === 1,
  'bare @name in prose becomes a marker with no mentions array (the MCP path)',
);
check(
  prose.json.mentions[0]?.participantId === aliceP.id,
  'prose mention produces a mention row',
);

/* ------------------------------------- 3. retroactive rename */

const renamed = await req(`${base}/participants/${aliceP.id}`, {
  method: 'PATCH',
  body: { displayName: 'alicia' },
  jar: fede,
});
check(renamed.status === 200 && renamed.json.displayName === 'alicia', 'rename accepted');

const afterRename = (await req(`${base}/messages`, { jar: fede })).json;
const composedAfter = afterRename.find((m) => m.id === composed.json.id);
check(
  composedAfter.mentions[0].displayName === 'alicia',
  'THE OLD MESSAGE NOW RESOLVES TO THE NEW NAME — retroactively, no backfill',
);
check(
  composedAfter.content === `hey <@${aliceP.id}> can you look at this`,
  'stored content was not rewritten by the rename',
);
check(
  composedAfter.mentions[0].participantId === aliceP.id,
  'mention still points at the same participant',
);

/* ---------------------------- 4. rename validation */

const dup = await req(`${base}/participants/${fedeP.id}`, {
  method: 'PATCH',
  body: { displayName: 'alicia' },
  jar: fede,
});
check(dup.status === 409, 'renaming to a name already used in the session is refused');

const bogus = await req(`${base}/participants/${fedeP.id}`, {
  method: 'PATCH',
  body: { displayName: 'has spaces' },
  jar: fede,
});
check(bogus.status === 400, 'a display name that cannot be a handle is refused');

const empty = await req(`${base}/participants/${fedeP.id}`, {
  method: 'PATCH',
  body: { displayName: '   ' },
  jar: fede,
});
check(empty.status === 400, 'empty display name refused');

/* --------------------- 5. a member may rename only themselves */

const aliceRenamesFede = await req(`${base}/participants/${fedeP.id}`, {
  method: 'PATCH',
  body: { displayName: 'not-yours' },
  jar: alice,
});
check(
  aliceRenamesFede.status === 404,
  'a member cannot rename someone else (404, not 403)',
);

const aliceRenamesSelf = await req(`${base}/participants/${aliceP.id}`, {
  method: 'PATCH',
  body: { displayName: 'alice' },
  jar: alice,
});
check(aliceRenamesSelf.status === 200, 'a member can rename themselves');

/* ------------- 6. cross-session mention refused, not dropped */

const other = (
  await req('/sessions', {
    method: 'POST',
    body: { title: `Unrelated ${stamp}` },
    jar: fede,
  })
).json;
const otherBase = `/o/${other.ownerSlug}/s/${other.publicId}`;
const otherParticipants = (await req(`${otherBase}/participants`, { jar: fede })).json;

const foreign = await req(`${base}/messages`, {
  method: 'POST',
  body: { content: 'trying to reach out', mentions: [otherParticipants[0].id] },
  jar: fede,
});
check(
  foreign.status === 400,
  'mentioning a participant from ANOTHER session is refused with 400, not dropped',
);

const foreignMarker = await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `smuggled <@${otherParticipants[0].id}> marker` },
  jar: fede,
});
check(
  foreignMarker.status === 400,
  'a hand-written marker for a foreign participant is refused too',
);

const invented = await req(`${base}/messages`, {
  method: 'POST',
  body: { content: 'x', mentions: ['00000000-0000-0000-0000-000000000000'] },
  jar: fede,
});
check(invented.status === 400, 'an invented participant id is refused');

/* ---------------------------- 7. text that must NOT become a mention */

const email = await req(`${base}/messages`, {
  method: 'POST',
  body: { content: 'mail me at fede@example.com' },
  jar: fede,
});
check(
  email.json.mentions.length === 0 && !MARKER.test(email.json.content),
  'an email address is not turned into a mention',
);

const pkg = await req(`${base}/messages`, {
  method: 'POST',
  body: { content: 'install hono@4.13.9 please' },
  jar: fede,
});
check(pkg.json.mentions.length === 0, 'a package version spec is not a mention');

const unknown = await req(`${base}/messages`, {
  method: 'POST',
  body: { content: 'ping @nobody-here' },
  jar: fede,
});
check(
  unknown.json.mentions.length === 0 &&
    unknown.json.content === 'ping @nobody-here',
  'an unknown handle is left as plain text',
);

/* ------------------- 8. mention with no inline text (programmatic) */

const silent = await req(`${base}/messages`, {
  method: 'POST',
  body: { content: 'no handle in this text', mentions: [aliceP.id] },
  jar: fede,
});
check(
  silent.json.content === 'no handle in this text' &&
    silent.json.mentions[0]?.participantId === aliceP.id,
  'an explicit mention with no inline text still records the mention',
);

/* ----------------------------------------------------------- cleanup */

await req(base, { method: 'DELETE', jar: fede });
await req(otherBase, { method: 'DELETE', jar: fede });
await admin(['delete-user', '--email', aliceEmail]).catch(() => {});

console.log(
  failures === 0 ? '\nM2 acceptance: PASS' : `\nM2 acceptance: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
