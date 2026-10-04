/**
 * M1 acceptance: auth, session CRUD, membership, invite links, privacy.
 *
 * Asserts the security properties from docs/security.md, not just happy paths:
 * no open registration, 404-not-403 for non-members, single-use invites,
 * email-scoped invites, and immediate revocation on password reset.
 *
 * Requires: server on :9090 and an existing account (see docs/operations.md).
 * Run: node scripts/acceptance/m1.mjs
 */
import { execFile as execFileCb } from 'node:child_process';

const API = 'http://localhost:9090/api';

let failures = 0;
const ok = (msg) => console.log('ok  ', msg);
const bad = (msg) => {
  console.error('FAIL', msg);
  failures++;
};
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

/** Minimal cookie jar: one per simulated browser. */
function jar() {
  let cookie = '';
  return {
    get headers() {
      return cookie ? { cookie } : {};
    },
    capture(res) {
      const set = res.headers.getSetCookie?.() ?? [];
      for (const c of set) {
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
    redirect: 'manual',
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

/**
 * Run the admin CLI, feeding a password on stdin.
 *
 * --password-stdin reads until stdin closes, so stdin MUST be ended or the
 * child hangs forever.
 */
function admin(args, stdinValue) {
  return new Promise((resolve, reject) => {
    const child = execFileCb('pnpm', ['admin', ...args], (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
    child.stdin.end(stdinValue ?? '');
  });
}

const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PW = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';
const stamp = Date.now();
const aliceEmail = `alice-${stamp}@example.com`;
const carolEmail = `carol-${stamp}@example.com`;

/* ---------------------------------------------------------------- 1. login */

const fede = jar();
const badLogin = await req('/auth/login', {
  method: 'POST',
  body: { email: EMAIL, password: 'wrong-password' },
});
check(badLogin.status === 401, 'wrong password rejected with 401');
check(
  badLogin.json?.error === 'invalid email or password',
  'login error does not distinguish unknown user from wrong password',
);

const nosuch = await req('/auth/login', {
  method: 'POST',
  body: { email: `nobody-${stamp}@example.com`, password: PW },
});
check(
  nosuch.status === 401 && nosuch.json?.error === badLogin.json?.error,
  'unknown account returns the identical error (no enumeration oracle)',
);

const login = await req('/auth/login', {
  method: 'POST',
  body: { email: EMAIL, password: PW },
  jar: fede,
});
check(login.status === 200, 'correct password logs in');

const me = await req('/auth/me', { jar: fede });
check(me.status === 200 && me.json?.user?.email === EMAIL, '/auth/me identifies the signed-in account');

const anon = await req('/auth/me');
check(anon.status === 401, 'no cookie -> 401 on /auth/me');

/* ------------------------------------------------- 2. no open registration */

const openSignup = await req('/auth/signup', {
  method: 'POST',
  body: { email: `sneak-${stamp}@example.com`, password: PW, displayName: 'sneak' },
});
check(openSignup.status === 400, 'signup without an invite token is refused');

const forgedSignup = await req('/auth/signup', {
  method: 'POST',
  body: {
    token: 'not-a-real-token',
    email: `sneak2-${stamp}@example.com`,
    password: PW,
    displayName: 'sneak2',
  },
});
check(forgedSignup.status === 400, 'signup with a forged invite token is refused');

/* ----------------------------------------------------- 3. session CRUD */

const created = await req('/sessions', {
  method: 'POST',
  body: { title: `Investigate flaky test ${stamp}` },
  jar: fede,
});
check(created.status === 201 && created.json?.role === 'owner', 'creator becomes owner');
const S = created.json;
const base = `/o/${S.ownerSlug}/s/${S.publicId}`;

const renamed = await req(base, {
  method: 'PATCH',
  body: { title: 'Renamed session' },
  jar: fede,
});
check(renamed.status === 200, 'owner can rename');

const afterRename = await req(base, { jar: fede });
check(afterRename.json?.session?.title === 'Renamed session', 'rename persisted');

const archived = await req(base, { method: 'PATCH', body: { status: 'archived' }, jar: fede });
const afterArchive = await req(base, { jar: fede });
check(
  archived.status === 200 && afterArchive.json?.session?.status === 'archived',
  'owner can archive',
);
await req(base, { method: 'PATCH', body: { status: 'active' }, jar: fede });

const emptyTitle = await req('/sessions', { method: 'POST', body: { title: '  ' }, jar: fede });
check(emptyTitle.status === 400, 'empty session title rejected');

const anonList = await req('/sessions');
check(anonList.status === 401, 'session list requires auth');

/* ------------------------------------------------ 4. invite link redemption */

const invite = await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede });
check(invite.status === 201 && !!invite.json?.token, 'invite returns a token once');
check(
  typeof invite.json?.url === 'string' && invite.json.url.includes(invite.json.token),
  'invite returns a copyable URL containing the token',
);
check(
  invite.json?.invite && !('token' in invite.json.invite),
  'invite summary carries no token (not recoverable later)',
);

const listed = await req(`${base}/invites`, { jar: fede });
check(
  Array.isArray(listed.json) &&
    listed.json.length > 0 &&
    !JSON.stringify(listed.json).includes(invite.json.token),
  'listing invites never exposes the plaintext token',
);

const preview = await req(`/invites/${invite.json.token}`);
check(preview.status === 200 && !!preview.json?.sessionTitle, 'invite preview works unauthenticated');

const alice = jar();
const signup = await req('/auth/signup', {
  method: 'POST',
  body: {
    token: invite.json.token,
    email: aliceEmail,
    password: PW,
    displayName: 'alice',
  },
  jar: alice,
});
check(signup.status === 201, 'invite link redeemed via signup');
check(signup.json?.session?.publicId === S.publicId, 'redemption joins the right session');

const aliceView = await req(base, { jar: alice });
check(aliceView.status === 200, 'alice can now see the session');
check(aliceView.json?.me?.role === 'member', 'alice joined as member, not owner');
check(aliceView.json?.members?.length === 2, 'session now has two members');

/* ----------------------------------------------------- 5. single use */

const reuse = await req('/auth/signup', {
  method: 'POST',
  body: {
    token: invite.json.token,
    email: `second-${stamp}@example.com`,
    password: PW,
    displayName: 'second',
  },
});
check(reuse.status === 400, 'invite link cannot be redeemed twice (single use)');

/* ----------------------------------------------------- 6. revocation */

const toRevoke = await req(`${base}/invites`, { method: 'POST', body: {}, jar: fede });
const revoked = await req(`${base}/invites/${toRevoke.json.invite.id}/revoke`, {
  method: 'POST',
  jar: fede,
});
check(revoked.status === 200, 'owner can revoke an unredeemed invite');

const afterRevoke = await req('/auth/signup', {
  method: 'POST',
  body: {
    token: toRevoke.json.token,
    email: `revoked-${stamp}@example.com`,
    password: PW,
    displayName: 'revoked',
  },
});
check(afterRevoke.status === 400, 'revoked invite cannot be redeemed');

/* --------------------------------------- 7. email-scoped invite, no mail sent */

const scoped = await req(`${base}/invites`, {
  method: 'POST',
  body: { invitedEmail: 'intended@example.com' },
  jar: fede,
});
const wrongEmail = await req('/auth/signup', {
  method: 'POST',
  body: {
    token: scoped.json.token,
    email: `interloper-${stamp}@example.com`,
    password: PW,
    displayName: 'interloper',
  },
});
check(
  wrongEmail.status === 403,
  'email-scoped invite refuses a different address (enforced at redemption, no mail server)',
);

/* ------------------------------------------- 8. privacy: 404, never 403 */

await admin(
  ['create-user', '--email', carolEmail, '--name', 'carol', '--password-stdin'],
  PW,
);

const carol = jar();
const carolLogin = await req('/auth/login', {
  method: 'POST',
  body: { email: carolEmail, password: PW },
  jar: carol,
});
check(carolLogin.status === 200, 'carol can log in');

const carolPeek = await req(base, { jar: carol });
check(carolPeek.status === 404, 'NON-MEMBER GETS 404, NOT 403 — existence is private');

const carolPost = await req(`${base}/messages`, {
  method: 'POST',
  body: { content: 'should never land' },
  jar: carol,
});
check(carolPost.status === 404, 'non-member cannot post (404)');

const carolInvites = await req(`${base}/invites`, { jar: carol });
check(carolInvites.status === 404, 'non-member cannot list invites (404)');

const carolSessions = await req('/sessions', { jar: carol });
check(
  Array.isArray(carolSessions.json) &&
    !carolSessions.json.some((s) => s.publicId === S.publicId),
  "carol's session list does not include the private session",
);

const wrongOwner = await req(`/o/carol/s/${S.publicId}`, { jar: fede });
check(wrongOwner.status === 404, 'wrong owner slug in path -> 404 (ADR 0006)');

/* ------------------------------------ 9. member cannot mutate the session */

const aliceRename = await req(base, {
  method: 'PATCH',
  body: { title: 'alice was here' },
  jar: alice,
});
check(aliceRename.status === 404, 'member cannot rename (404, not 403)');

const aliceInvite = await req(`${base}/invites`, { method: 'POST', body: {}, jar: alice });
check(aliceInvite.status === 404, 'member cannot create invites');

const aliceDelete = await req(base, { method: 'DELETE', jar: alice });
check(aliceDelete.status === 404, 'member cannot delete the session');

/* -------------------------------------- 10. author identity is server-side */

const aliceMsg = await req(`${base}/messages`, {
  method: 'POST',
  body: { content: 'alice speaking', mentions: [] },
  jar: alice,
});
check(
  aliceMsg.status === 201 && aliceMsg.json?.author?.displayName === 'alice',
  'message author comes from the session cookie, not the request body',
);

/* --------------------------------- 11. last owner cannot be removed */

const fedeUserId = aliceView.json.members.find((m) => m.role === 'owner').userId;
const removeOwner = await req(`${base}/members/${fedeUserId}`, {
  method: 'DELETE',
  jar: fede,
});
check(removeOwner.status === 409, 'cannot remove the last owner');

/* ------------------------- 12. password reset invalidates live sessions */

await admin(
  ['reset-password', '--email', aliceEmail, '--password-stdin'],
  'a-brand-new-password',
);

const aliceAfterReset = await req('/auth/me', { jar: alice });
check(
  aliceAfterReset.status === 401,
  "password reset immediately invalidates alice's existing login",
);

const aliceRelogin = await req('/auth/login', {
  method: 'POST',
  body: { email: aliceEmail, password: 'a-brand-new-password' },
  jar: alice,
});
check(aliceRelogin.status === 200, 'alice can log in with the new password');

/* ------------------------------------------------------- 13. logout */

const beforeLogout = await req('/auth/me', { jar: fede });
await req('/auth/logout', { method: 'POST', jar: fede });
const afterLogout = await req('/auth/me', { jar: fede });
check(
  beforeLogout.status === 200 && afterLogout.status === 401,
  'logout invalidates the session server-side',
);

/* ----------------------------------------------------------- cleanup */

// Re-login as fede (step 13 logged him out) so the session can be removed.
await req('/auth/login', {
  method: 'POST',
  body: { email: EMAIL, password: PW },
  jar: fede,
});
await req(base, { method: 'DELETE', jar: fede }).catch(() => {});

for (const email of [aliceEmail, carolEmail]) {
  await admin(['delete-user', '--email', email]).catch(() => {});
}

console.log(
  failures === 0 ? '\nM1 acceptance: PASS' : `\nM1 acceptance: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
