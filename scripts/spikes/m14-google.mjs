/**
 * M14 spike: verify the three documented claims ADR 0021 rests on, against a
 * real Google account, before any of M14 is built.
 *
 *   1. A `drive.file` token can write a doc shared with you, but only after you
 *      pick it once in the Google Picker. (We check it is refused BEFORE the
 *      pick too, or a pass would prove nothing.)
 *   2. Anchored edits map onto the Docs API: locate `old_text` uniquely in the
 *      body, delete + insert in one batchUpdate guarded by `requiredRevisionId`,
 *      and a stale revision is refused rather than merged. Also checked, because
 *      the ADR leans on them: Drive's revision history names the editor, and
 *      Markdown export works under `drive.file`.
 *   3. Whether the Docs editor can be embedded in an iframe, or only previewed.
 *      This one needs your eyes — the page shows both.
 *
 * Zero dependencies. Tokens live in memory only and are never written to disk.
 *
 * Setup (once), in a Google Cloud project:
 *   - Enable the Google Drive API, Google Docs API and Google Picker API.
 *   - OAuth consent screen: External, Testing, add BOTH test accounts as users.
 *   - OAuth client, type "Web application":
 *       authorised JavaScript origin  http://localhost:9091
 *       authorised redirect URI       http://localhost:9091/callback
 *   - An API key (restrict it to the Picker API).
 *   - The project NUMBER (Cloud console home) — the Picker's App ID.
 *
 * Run:
 *   GOOGLE_CLIENT_ID=… GOOGLE_CLIENT_SECRET=… GOOGLE_API_KEY=… \
 *   GOOGLE_APP_ID=<project number> GOOGLE_TEST_EDITOR_EMAIL=<account B> \
 *   node scripts/spikes/m14-google.mjs
 *
 * then open http://localhost:9091 and follow the steps. Account A creates and
 * shares the doc; account B is the member it is shared with. Use a second
 * browser profile for B, or pick B in Google's account chooser.
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';

const PORT = 9091;
const ORIGIN = `http://localhost:${PORT}`;
const REDIRECT = `${ORIGIN}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email';
const OUT = '.artifacts/m14-verify.json';

const env = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`missing ${k} — see the header of this file`);
    process.exit(2);
  }
  return v;
};
const CLIENT_ID = env('GOOGLE_CLIENT_ID');
const CLIENT_SECRET = env('GOOGLE_CLIENT_SECRET');
const API_KEY = env('GOOGLE_API_KEY');
const APP_ID = env('GOOGLE_APP_ID');
const EDITOR_EMAIL = env('GOOGLE_TEST_EDITOR_EMAIL');

/** role -> { token, email } */
const accounts = {};
let docId = null;
/** claim id -> { pass: boolean | null, detail } ; null = needs a human verdict */
const results = {};
const log = [];

const record = (id, pass, detail) => {
  results[id] = { pass, detail };
  log.push(`${pass === true ? 'ok  ' : pass === false ? 'FAIL' : 'look'} ${id}: ${detail}`);
  console.log(log.at(-1));
  mkdirSync('.artifacts', { recursive: true });
  writeFileSync(OUT, JSON.stringify({ docId, at: new Date().toISOString(), results }, null, 2));
};

// ---------------------------------------------------------------- Google calls

async function g(role, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accounts[role].token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DOCS = 'https://docs.googleapis.com/v1/documents';

/**
 * The body's plain text, plus the Docs index of every character. Docs indexes
 * in UTF-16 code units, which is what JS strings index in, so a character's
 * offset maps straight across — as long as we only walk text runs.
 */
function flatten(doc) {
  let text = '';
  const at = [];
  const walk = (content) => {
    for (const el of content ?? []) {
      for (const pe of el.paragraph?.elements ?? []) {
        const run = pe.textRun;
        if (!run) continue;
        for (let i = 0; i < run.content.length; i++) {
          text += run.content[i];
          at.push(pe.startIndex + i);
        }
      }
      for (const row of el.table?.tableRows ?? []) for (const cell of row.tableCells ?? []) walk(cell.content);
    }
  };
  walk(doc.body?.content);
  return { text, at };
}

/** The adapter's anchored edit, as M14 would implement it. */
async function anchoredEdit(role, oldText, newText, revisionId) {
  const doc = (await g(role, 'GET', `${DOCS}/${docId}`)).json;
  const { text, at } = flatten(doc);
  const pos = text.indexOf(oldText);
  if (pos < 0) return { error: 'anchor_not_found' };
  if (text.indexOf(oldText, pos + 1) >= 0) return { error: 'anchor_ambiguous' };
  const start = at[pos];
  const end = at[pos + oldText.length - 1] + 1;
  if (end - start !== oldText.length) return { error: 'anchor_spans_non_text' };
  return g(role, 'POST', `${DOCS}/${docId}:batchUpdate`, {
    requests: [
      { deleteContentRange: { range: { startIndex: start, endIndex: end } } },
      { insertText: { location: { index: start }, text: newText } },
    ],
    writeControl: { requiredRevisionId: revisionId ?? doc.revisionId },
  });
}

// ---------------------------------------------------------------- the steps

async function afterCreatorSignIn() {
  const created = await g('A', 'POST', `${DRIVE}/files`, {
    name: `Fabrikka M14 spike ${new Date().toISOString()}`,
    mimeType: 'application/vnd.google-apps.document',
  });
  if (created.status !== 200) return record('setup.create', false, `create ${created.status} ${created.text}`);
  docId = created.json.id;
  const seeded = await g('A', 'POST', `${DOCS}/${docId}:batchUpdate`, {
    requests: [
      {
        insertText: {
          location: { index: 1 },
          text: 'The quick brown fox.\nA sentence the agent will rewrite.\nThe last line.\n',
        },
      },
    ],
  });
  record('setup.create', seeded.status === 200, `doc ${docId} created and seeded as ${accounts.A.email}`);
  const shared = await g('A', 'POST', `${DRIVE}/files/${docId}/permissions?sendNotificationEmail=false`, {
    type: 'user',
    role: 'writer',
    emailAddress: EDITOR_EMAIL,
  });
  record('setup.share', shared.status === 200, `shared with ${EDITOR_EMAIL}: ${shared.status}`);
}

async function editorTriesBeforePick() {
  const res = await g('B', 'POST', `${DOCS}/${docId}:batchUpdate`, {
    requests: [{ insertText: { location: { index: 1 }, text: 'before-pick ' } }],
  });
  // A refusal here is the expected result; a success means drive.file is
  // broader than documented, which is good news but changes the Setup flow.
  record(
    'claim1.refused_before_pick',
    res.status === 403 || res.status === 404,
    `B writes a shared doc without picking it: ${res.status} ${res.json?.error?.status ?? ''}`,
  );
}

async function afterEditorPicked(pickedId) {
  if (pickedId !== docId) record('claim1.picked', false, `picked ${pickedId}, expected ${docId}`);
  const res = await g('B', 'POST', `${DOCS}/${docId}:batchUpdate`, {
    requests: [{ insertText: { location: { index: 1 }, text: 'Picked. ' } }],
  });
  record('claim1.writes_after_pick', res.status === 200, `B writes after one Picker pick: ${res.status} ${res.json?.error?.message ?? ''}`);
  if (res.status !== 200) return;

  // Claim 2: anchored edit lands.
  const edit = await anchoredEdit('B', 'A sentence the agent will rewrite.', 'A sentence claude-b rewrote.');
  record('claim2.anchored_edit', edit.status === 200, `delete+insert at a unique anchor: ${edit.status ?? edit.error}`);

  const ambiguous = await anchoredEdit('B', 'The ', 'X');
  record('claim2.ambiguous_refused', ambiguous.error === 'anchor_ambiguous', `"The " occurs twice: ${ambiguous.error ?? ambiguous.status}`);

  // Claim 2: a stale requiredRevisionId is refused, not merged.
  const stale = (await g('B', 'GET', `${DOCS}/${docId}`)).json.revisionId;
  await g('A', 'POST', `${DOCS}/${docId}:batchUpdate`, {
    requests: [{ insertText: { location: { index: 1 }, text: 'Racing. ' } }],
  });
  const raced = await anchoredEdit('B', 'The last line.', 'The final line.', stale);
  record(
    'claim2.stale_revision_refused',
    raced.status === 400,
    `edit against a revision another editor moved past: ${raced.status} ${raced.json?.error?.message ?? ''}`,
  );
  const retried = await anchoredEdit('B', 'The last line.', 'The final line.');
  record('claim2.retry_once_lands', retried.status === 200, `re-read and retry: ${retried.status}`);

  // Attribution in Google's own history. Drive may batch nearby edits into one
  // revision, so this asks only that B appears at all.
  const revs = await g(
    'A',
    'GET',
    `${DRIVE}/files/${docId}/revisions?fields=revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress))`,
  );
  const editors = [...new Set((revs.json?.revisions ?? []).map((r) => r.lastModifyingUser?.emailAddress ?? r.lastModifyingUser?.displayName))];
  record(
    'claim2.history_names_editor',
    revs.status === 200 && editors.some((e) => e && e.toLowerCase() === accounts.B.email.toLowerCase()),
    `revisions list ${revs.status}, editors seen: ${editors.join(', ') || 'none'}`,
  );

  const md = await g('B', 'GET', `${DRIVE}/files/${docId}/export?mimeType=text/markdown`);
  record('claim2.markdown_export', md.status === 200 && md.text.includes('claude-b rewrote'), `Markdown export: ${md.status}, ${md.text.length} chars`);
}

async function embedHeaders() {
  // Unauthenticated, so this sees what a browser without a Google session sees.
  // The iframes on /embed are the real verdict.
  const out = [];
  for (const path of ['edit', 'preview']) {
    const res = await fetch(`https://docs.google.com/document/d/${docId}/${path}`, { redirect: 'manual' });
    out.push(`${path}: ${res.status} x-frame-options=${res.headers.get('x-frame-options') ?? '-'} csp-frame-ancestors=${/frame-ancestors[^;]*/.exec(res.headers.get('content-security-policy') ?? '')?.[0] ?? '-'}`);
  }
  record('claim3.headers', null, out.join(' | '));
}

// ---------------------------------------------------------------- pages

const page = (body) =>
  `<!doctype html><meta charset="utf-8"><title>M14 spike</title>
<style>body{font:15px system-ui;max-width:880px;margin:2rem auto;padding:0 16px}
li{margin:.5rem 0}pre{background:#f4f4f4;padding:1rem;white-space:pre-wrap}
iframe{width:100%;height:360px;border:1px solid #ccc}</style>${body}`;

function home() {
  const step = (done, html) => `<li>${done ? '✅' : '⬜'} ${html}</li>`;
  return page(`<h1>M14 — verify before building</h1><ol>
${step(accounts.A, `<a href="/auth?role=A">Sign in as the creator (account A)</a> — creates and shares a doc`)}
${step(accounts.B, `<a href="/auth?role=B">Sign in as ${EDITOR_EMAIL} (account B)</a> — tries to write before picking`)}
${step(results['claim1.writes_after_pick'], `<a href="/picker">As B, open the doc with the Picker</a> — then claims 1 and 2 run`)}
${step(results['claim3.headers'], `<a href="/embed">Look at the embed page</a> — claim 3 is your call`)}
<li>Optional: edit the doc directly in Google Docs as A, then <a href="/poll">poll its revisions</a></li>
</ol>${docId ? `<p>Doc: <a href="https://docs.google.com/document/d/${docId}/edit" target="_blank">${docId}</a></p>` : ''}
<pre>${log.join('\n') || 'nothing yet'}</pre><p>Results are written to <code>${OUT}</code>.</p>`);
}

function picker() {
  return page(`<h1>Pick the spike doc as ${accounts.B?.email ?? 'B'}</h1>
<p>The Picker should show exactly one document. Select it.</p><p id="s"></p>
<script src="https://apis.google.com/js/api.js"></script><script>
gapi.load('picker', () => {
  const view = new google.picker.DocsView(google.picker.ViewId.DOCUMENTS).setFileIds(${JSON.stringify(docId)});
  new google.picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(${JSON.stringify(accounts.B?.token ?? '')})
    .setDeveloperKey(${JSON.stringify(API_KEY)})
    .setAppId(${JSON.stringify(APP_ID)})
    .setCallback(async (d) => {
      if (d.action !== google.picker.Action.PICKED) return;
      document.getElementById('s').textContent = 'Running claims 1 and 2…';
      await fetch('/picked?id=' + encodeURIComponent(d.docs[0].id), { method: 'POST' });
      location.href = '/';
    })
    .build().setVisible(true);
});
</script>`);
}

function embed() {
  return page(`<h1>Claim 3 — can the editor be embedded?</h1>
<p>Signed in to Google in this browser as A or B? Then: if the first frame shows an
<strong>editable</strong> doc, the editor embeds. If it is blank or refuses, only the
preview (second frame) is available and the pane shows a preview with an
<em>Open in Google Docs</em> button. Record what you see.</p>
<h3>/edit</h3><iframe src="https://docs.google.com/document/d/${docId}/edit"></iframe>
<h3>/preview</h3><iframe src="https://docs.google.com/document/d/${docId}/preview"></iframe>
<p><a href="/">back</a></p>`);
}

async function poll() {
  const revs = await g(
    'A',
    'GET',
    `${DRIVE}/files/${docId}/revisions?fields=revisions(id,modifiedTime,lastModifyingUser(displayName,emailAddress))`,
  );
  const doc = await g('A', 'GET', `${DOCS}/${docId}`);
  return page(`<h1>Revisions</h1><p>Docs revisionId now: <code>${doc.json?.revisionId}</code></p>
<pre>${JSON.stringify(revs.json, null, 2)}</pre><p><a href="/poll">poll again</a> · <a href="/">back</a></p>`);
}

// ---------------------------------------------------------------- server

createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const send = (html, status = 200) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  };
  try {
    if (url.pathname === '/') return send(home());

    if (url.pathname === '/auth') {
      const role = url.searchParams.get('role');
      const q = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        response_type: 'code',
        scope: SCOPE,
        state: role,
        prompt: 'select_account consent',
        ...(role === 'B' ? { login_hint: EDITOR_EMAIL } : {}),
      });
      res.writeHead(302, { location: `https://accounts.google.com/o/oauth2/v2/auth?${q}` });
      return res.end();
    }

    if (url.pathname === '/callback') {
      const role = url.searchParams.get('state');
      const tok = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          code: url.searchParams.get('code') ?? '',
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT,
          grant_type: 'authorization_code',
        }),
      }).then((r) => r.json());
      if (!tok.access_token) return send(page(`<pre>${JSON.stringify(tok, null, 2)}</pre>`), 400);
      const claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString());
      accounts[role] = { token: tok.access_token, email: claims.email };
      record(`signin.${role}`, true, `${claims.email}, scopes granted: ${tok.scope}`);
      if (role === 'B' && claims.email.toLowerCase() !== EDITOR_EMAIL.toLowerCase())
        record('signin.B', false, `signed in as ${claims.email}, but the doc is shared with ${EDITOR_EMAIL}`);
      if (role === 'A') await afterCreatorSignIn();
      if (role === 'B' && docId) await editorTriesBeforePick();
      res.writeHead(302, { location: '/' });
      return res.end();
    }

    if (url.pathname === '/picker') return send(picker());
    if (url.pathname === '/picked' && req.method === 'POST') {
      await afterEditorPicked(url.searchParams.get('id'));
      await embedHeaders();
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/embed') return send(embed());
    if (url.pathname === '/poll') return send(await poll());

    send('not found', 404);
  } catch (err) {
    console.error(err);
    send(page(`<pre>${String(err?.stack ?? err)}</pre>`), 500);
  }
}).listen(PORT, () => console.log(`M14 spike on ${ORIGIN}`));
