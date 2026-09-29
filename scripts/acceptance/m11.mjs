/**
 * M11 acceptance: the three-pane session screen.
 *
 * A layout is judged by eye, so the manual test in docs/roadmap.md is the real
 * gate. What is checked here is the part that is not cosmetic:
 *
 *   1. The SHIPPED build actually carries the layout — same reasoning as M9,
 *      where the server not serving the web app was invisible in development.
 *   2. A MEMBER can add their own agent. The server has allowed this since M3;
 *      the web app gated the panel on `isOwner`, so `@claude-alice` could not be
 *      created through the interface at all (ADR 0018). A UI-only fix has no
 *      other way to be regression-tested from here.
 *   3. Owner-only controls in the rail are absent for a member, not broken —
 *      404, as everywhere else.
 *   4. The list still carries what the rail needs to decide what to show.
 *
 * Requires: server on :9090, a web build, and an account.
 */
const ORIGIN = 'http://localhost:9090';
const API = `${ORIGIN}/api`;
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

const stamp = Date.now();

/* ------------------------------------------- 1. the build carries the layout */

const html = await fetch(`${ORIGIN}/`).then((r) => r.text());
const js = html.match(/\/assets\/[^"]+\.js/)?.[0];
const css = html.match(/\/assets\/[^"]+\.css/)?.[0];
check(!!js && !!css, 'the page references a built script and stylesheet');

const script = js ? await fetch(`${ORIGIN}${js}`).then((r) => r.text()) : '';
const styles = css ? await fetch(`${ORIGIN}${css}`).then((r) => r.text()) : '';

check(script.includes('rail setup'), 'the shipped build renders a setup rail');
check(script.includes('rail output'), 'the shipped build renders an output rail');
check(script.includes('pane-toggle'), 'the shipped build renders the pane toggles');
check(
  script.includes('fabrikka.panes'),
  'collapsed state is remembered per session, client-side',
);
check(
  styles.includes('--rail-setup') && styles.includes('minmax(0, 1fr)'),
  'the conversation column takes the width a closed rail gives up',
);
check(
  styles.includes("data-setup=closed] .rail"),
  'a closed rail is removed, not merely narrowed (no stray tab stop)',
);
check(
  styles.includes('.pane-backdrop'),
  'an overlaid rail has a way out on a narrow screen',
);
/* The pre-M11 shell is gone: dead CSS reads as the layout to the next person. */
check(
  !/\.app\{[^}]*grid-template-columns/.test(styles),
  'the two-column shell it replaced is not still in the stylesheet',
);

/* ------------------------------------------------------------------ setup */

const fede = jar();
if (
  (
    await req('/auth/login', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD },
      jar: fede,
    })
  ).status !== 200
) {
  console.error(`could not log in as ${EMAIL}`);
  process.exit(1);
}

const S = (
  await req('/sessions', { method: 'POST', body: { title: `Panes ${stamp}` }, jar: fede })
).json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;

const inv = await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede });
const alice = jar();
const aliceEmail = `alice-m11-${stamp}@example.com`;
const signup = await req('/auth/signup', {
  method: 'POST',
  body: {
    token: inv.json.token,
    email: aliceEmail,
    password: 'password123',
    displayName: `alice-m11-${stamp}`,
  },
  jar: alice,
});
check(signup.status === 200 || signup.status === 201, 'a second member joined');

/* --------------------------------- 2. a member can bring their own agent */

const mine = await req(`${base}/agents`, {
  method: 'POST',
  body: { displayName: `claude-alice-${stamp}`, provider: 'claude-code' },
  jar: alice,
});
check(mine.status === 201, 'a member can add their own agent');
check(!!mine.json?.token, 'and gets a token for it');
check(
  mine.json?.setup?.lanes?.includes('bridge'),
  'and the setup block for its provider, not a generic one',
);

/* Their own agent's controls are theirs, though they do not own the session. */
const trust = await req(`${base}/agents/${mine.json.agent.sessionAgentId}/trust`, {
  method: 'PATCH',
  body: { trustTier: 'session_trusted' },
  jar: alice,
});
check(trust.status === 200, "a member can elevate trust on their OWN agent");

const steps = await req(`${base}/agents/${mine.json.agent.sessionAgentId}/activity`, {
  method: 'PATCH',
  body: { visible: false },
  jar: alice,
});
check(steps.status === 200, "a member can hide their OWN agent's steps");

/* ------------------------- 3. owner-only rail controls are absent, not broken */

const theirs = await req(`${base}/agents`, {
  method: 'POST',
  body: { displayName: `claude-fede-${stamp}`, provider: 'claude-code' },
  jar: fede,
});

const poke = await req(`${base}/agents/${theirs.json.agent.sessionAgentId}/trust`, {
  method: 'PATCH',
  body: { trustTier: 'session_trusted' },
  jar: alice,
});
check(poke.status === 404, "a member cannot touch another member's agent (404)");

check((await req(`${base}/tokens`, { jar: alice })).status === 404, 'tokens are owner-only');
check((await req(`${base}/invites`, { jar: alice })).status === 404, 'invites are owner-only');
check(
  (await req(base, { method: 'DELETE', jar: alice })).status === 404,
  'deleting the session is owner-only',
);

/* ------------------------- 4. the rail can tell whose agent is whose */

const listed = (await req(`${base}/agents`, { jar: alice })).json;
check(
  Array.isArray(listed) && listed.length === 2,
  'both members see both agents in the session',
);
check(
  listed.every((a) => typeof a.ownerUserId === 'string' && a.ownerUserId.length > 0),
  'every agent reports its owner, so the rail knows which controls to render',
);
check(
  new Set(listed.map((a) => a.ownerUserId)).size === 2,
  'the two agents are attributed to two different people',
);
check(
  listed.every((a) => typeof a.activityVisible === 'boolean' && !!a.trustTier),
  'and reports the state those controls display',
);

/* The middle pane is unaffected by any of this. */
await req(`${base}/messages`, {
  method: 'POST',
  body: { content: `hello from alice ${stamp}` },
  jar: alice,
});
const messages = (await req(`${base}/messages`, { jar: fede })).json;
check(
  messages.some((m) => m.content.includes(`hello from alice ${stamp}`)),
  'the conversation still works for a member',
);

await req(base, { method: 'DELETE', jar: fede });

console.log(
  failures === 0 ? '\nM11 acceptance: PASS' : `\nM11 acceptance: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
