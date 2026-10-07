/**
 * The host's own window (M31): grant folders, pick their policy, watch runs,
 * stop everything. Served on 127.0.0.1 only — folders are granted on the
 * machine, never from the server (ADR 0027).
 *
 * Locked down like anything a web page could try to reach on localhost:
 *   - bound to 127.0.0.1;
 *   - a random secret from the link the host opens, kept in a SameSite=Strict
 *     cookie, required on every request;
 *   - the Host header must be 127.0.0.1/localhost on this port (DNS rebinding);
 *   - every change must come from this page's own Origin (CSRF).
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Host } from './host.ts';
import { addGrant, removeGrant, updateGrant } from './ops.ts';

const PREFERRED_PORT = Number(process.env.FABRIKKA_HOST_PORT ?? 17621);

export async function startControl(host: Host, say: (...a: unknown[]) => void): Promise<{ url: string }> {
  const secret = randomBytes(18).toString('base64url');
  let port = 0;

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      send(res, 500, { error: (err as Error).message });
    }
  });

  const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];
  const cookieOk = (req: IncomingMessage) => (req.headers.cookie ?? '').split(/;\s*/).includes(`host_k=${secret}`);

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!allowedHosts().includes(req.headers.host ?? '')) return send(res, 403, { error: 'wrong host' });
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/') {
      // The link the host opened carries the secret once; after that, the cookie.
      if (url.searchParams.get('k') === secret) {
        res.setHeader('Set-Cookie', `host_k=${secret}; HttpOnly; SameSite=Strict; Path=/`);
        res.writeHead(302, { Location: '/' });
        return res.end();
      }
      if (!cookieOk(req)) return sendHtml(res, 403, '<p>Open this page from the link the Fabrikka host printed.</p>');
      return sendHtml(res, 200, PAGE);
    }

    if (!cookieOk(req)) return send(res, 403, { error: 'not authorised' });
    if (req.method !== 'GET' && req.headers.origin !== `http://127.0.0.1:${port}` && req.headers.origin !== `http://localhost:${port}`) {
      return send(res, 403, { error: 'cross-origin request refused' });
    }

    if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, host.state());

    if (req.method === 'POST' && url.pathname === '/api/grants') {
      const added = addGrant(host, (await json(req)) as { path?: string; label?: string; policy?: unknown });
      return added.ok ? send(res, 201, host.state()) : send(res, 400, { error: added.error });
    }

    const m = /^\/api\/grants\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (m) {
      const done =
        req.method === 'DELETE'
          ? removeGrant(host, m[1]!)
          : req.method === 'POST'
            ? updateGrant(host, m[1]!, (await json(req)) as { label?: string; policy?: unknown })
            : null;
      if (done) return done.ok ? send(res, 200, host.state()) : send(res, done.error === 'no such grant' ? 404 : 400, { error: done.error });
    }

    if (req.method === 'POST' && url.pathname === '/api/stop') {
      host.stopAll();
      return send(res, 200, host.state());
    }
    send(res, 404, { error: 'not found' });
  }

  await new Promise<void>((resolve) => {
    server.once('error', () => server.listen(0, '127.0.0.1', resolve));
    server.listen(PREFERRED_PORT, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
  void say;
  return { url: `http://127.0.0.1:${port}/?k=${secret}` };
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  res.end(html);
}

async function json(req: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64_000) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

/** The page: plain HTML, no build step, the app's palette. */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fabrikka host</title>
<style>
  :root { --text:#293241; --muted:#5d6d82; --accent:#3d5a80; --tint:#e0fbfc; --border:#c9dde8; --danger:#c4492b; --ok:#2e7d5b; --peach:#ee6c4d; }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; color:var(--text); background:#f7fcfd; }
  header { background:#293241; color:#e0fbfc; padding:14px 20px; display:flex; align-items:center; gap:12px; }
  header strong { font-size:16px; } header .dot { width:9px; height:9px; border-radius:50%; background:#8ea2b6; }
  header .dot.on { background:#6fcf9f; } header .spacer { flex:1; }
  main { max-width:760px; margin:0 auto; padding:20px 16px 60px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:26px 0 8px; }
  .card { background:#fff; border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-bottom:8px; }
  .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .grow { flex:1; min-width:0; } .muted { color:var(--muted); font-size:13px; } .path { font-family:ui-monospace,monospace; font-size:12px; color:var(--muted); overflow-wrap:anywhere; }
  input, select, button { font:inherit; padding:7px 10px; border:1px solid var(--border); border-radius:7px; background:#fff; color:var(--text); }
  input { flex:1; min-width:14rem; } button { background:var(--accent); color:#fff; border-color:var(--accent); cursor:pointer; font-weight:600; }
  button.link { background:none; border:0; color:var(--accent); padding:4px; font-weight:500; } button.danger { background:var(--danger); border-color:var(--danger); }
  .stop { background:var(--peach); border-color:var(--peach); }
  .warn { color:var(--danger); font-size:13px; } .error { color:var(--danger); }
  .tag { font-size:12px; padding:1px 8px; border-radius:20px; background:var(--tint); color:var(--accent); }
  .tag.run { background:#fde8e2; color:var(--danger); }
  .update { border-color:var(--accent); background:var(--tint); } [hidden] { display:none !important; }
  table { width:100%; border-collapse:collapse; font-size:13px; } td { padding:5px 6px; border-top:1px solid var(--border); vertical-align:top; }
</style></head><body>
<header><span class="dot" id="dot"></span><strong>Fabrikka host</strong><span id="who" class="muted" style="color:#c9dbe6"></span><span class="spacer"></span><button class="stop" id="stop">Stop all runs</button></header>
<main>
  <div id="update" class="card update" hidden></div>
  <h2>Folders your agents may work in</h2>
  <p class="muted">Agents only ever run in folders granted here, on this computer. The website can choose among them, never add one.</p>
  <div id="grants"></div>
  <div class="card">
    <form id="add" class="row">
      <input id="path" placeholder="/Users/you/code/project" aria-label="Folder path">
      <select id="policy" aria-label="What agents may do">
        <option value="edit">Edit in folder</option>
        <option value="read">Read only</option>
        <option value="full">Full (commands, network)</option>
      </select>
      <button>Grant folder</button>
    </form>
    <p class="muted" id="policyhelp"></p>
    <p class="error" id="adderror"></p>
  </div>
  <h2>Agents on this computer</h2><div id="agents"></div>
  <h2>Recent runs</h2><div class="card"><table id="log"></table></div>
</main>
<script>
const HELP = {
  edit: 'Reads and edits files in this folder. No shell commands, no web, nothing outside the folder. Recommended.',
  read: 'Reads files in this folder and changes nothing.',
  full: 'Anything the agent tool can do: shell commands, network, files anywhere it can reach. Only for folders you would let a stranger run commands in.'
};
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j;
}
function render(s) {
  $('dot').className = 'dot' + (s.connected ? ' on' : '');
  // M33: never updates itself; says so, and how (ADR 0030).
  $('update').hidden = !s.updateAvailable;
  if (s.updateAvailable) $('update').innerHTML = '<strong>Update available</strong> <span class="muted">' + esc(s.version) + ' → ' + esc(s.latestVersion) + '</span><div class="muted">In a terminal: <code>fabrikka update</code>, then start the host again.</div>';
  $('who').textContent = s.deviceName + ' · ' + (s.connected ? 'connected to ' + s.server : 'reconnecting…') + (s.providers.length ? ' · ' + s.providers.join(', ') : ' · no agent tools found');
  $('grants').innerHTML = s.grants.length ? s.grants.map((g) => '<div class="card row"><div class="grow"><strong>' + esc(g.label) + '</strong><div class="path">' + esc(g.path) + '</div></div>' +
    '<select data-policy="' + g.id + '">' + ['edit','read','full'].map((p) => '<option value="' + p + '"' + (p === g.policy ? ' selected' : '') + '>' + ({edit:'Edit in folder',read:'Read only',full:'Full'})[p] + '</option>').join('') + '</select>' +
    '<button class="link" data-remove="' + g.id + '">Remove</button>' + (g.policy === 'full' ? '<div class="warn" style="flex-basis:100%">Full: agents can run any command on this computer from this folder.</div>' : '') + '</div>').join('')
    : '<p class="muted">No folders yet. Grant one below, then use “Add my agent” in a session.</p>';
  $('agents').innerHTML = s.agents.length ? s.agents.map((a) => '<div class="card row"><div class="grow"><strong>@' + esc(a.agent) + '</strong> <span class="muted">in ' + esc(a.session) + '</span></div><span class="tag">' + esc(a.folder ?? 'folder removed') + '</span>' + (a.running ? '<span class="tag run">running</span>' : a.active ? '<span class="tag">ready</span>' : '<span class="tag">not running</span>') + '</div>').join('')
    : '<p class="muted">No agents yet. In a session: Setup → Add my agent.</p>';
  $('log').innerHTML = s.log.length ? s.log.map((e) => '<tr><td class="muted">' + new Date(e.at).toLocaleTimeString() + '</td><td>@' + esc(e.agent) + '</td><td>' + esc(e.folder) + ' · ' + esc(e.policy) + '</td><td>' + esc(e.event) + (e.detail ? ' — ' + esc(e.detail) : '') + '</td></tr>').join('') : '<tr><td class="muted">Nothing has run yet.</td></tr>';
}
async function refresh() { try { render(await api('GET', '/api/state')); } catch {} }
$('policy').onchange = () => { $('policyhelp').textContent = HELP[$('policy').value]; };
$('policy').onchange();
$('add').onsubmit = async (e) => { e.preventDefault(); $('adderror').textContent = '';
  if ($('policy').value === 'full' && !confirm('Full lets agents run any command on this computer from this folder. Grant it anyway?')) return;
  try { render(await api('POST', '/api/grants', { path: $('path').value, policy: $('policy').value })); $('path').value = ''; } catch (err) { $('adderror').textContent = err.message; } };
document.addEventListener('change', async (e) => { const id = e.target.dataset && e.target.dataset.policy; if (!id) return;
  if (e.target.value === 'full' && !confirm('Full lets agents run any command on this computer from this folder. Continue?')) { refresh(); return; }
  render(await api('POST', '/api/grants/' + id, { policy: e.target.value })); });
document.addEventListener('click', async (e) => { const id = e.target.dataset && e.target.dataset.remove; if (id) render(await api('DELETE', '/api/grants/' + id)); });
$('stop').onclick = async () => render(await api('POST', '/api/stop'));
refresh(); setInterval(refresh, 2000);
</script></body></html>`;
