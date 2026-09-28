/**
 * M9 acceptance: the server serves the web app on one origin.
 *
 * The desktop shell is a packaging exercise and can only be judged by launching
 * it, so what is checked here is the thing it depends on: that a SINGLE origin
 * serves the UI, the API, the MCP endpoint and the bridge. Without that the
 * desktop app points at an API with no interface, which is how this gap was
 * found in the first place.
 *
 * Requires: server on :9090 and a web build (pnpm --filter @fabrikka/web build).
 */
const ORIGIN = 'http://localhost:9090';

let failures = 0;
const ok = (m) => console.log('ok  ', m);
const bad = (m) => {
  console.error('FAIL', m);
  failures++;
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

const html = await fetch(`${ORIGIN}/`).then((r) => r.text());
check(html.includes('<div id="root">'), 'the root path serves the web app');

/* Client-side routes must survive a hard refresh, or every deep link 404s. */
for (const path of ['/login', '/o/fede/s/demo', '/invite/abc']) {
  const res = await fetch(`${ORIGIN}${path}`);
  const body = await res.text();
  check(
    res.status === 200 && body.includes('<div id="root">'),
    `SPA route ${path} serves the app shell on a hard refresh`,
  );
}

const asset = html.match(/\/assets\/[^"]+\.js/)?.[0];
check(!!asset, 'the page references a hashed asset bundle');
if (asset) {
  const res = await fetch(`${ORIGIN}${asset}`);
  check(
    res.status === 200 && (res.headers.get('content-type') ?? '').includes('javascript'),
    'assets are served with the right content type',
  );
}

/* The fallback must not shadow anything real. */
const api = await fetch(`${ORIGIN}/api/auth/me`);
check(api.status === 401, 'the API still answers (not swallowed by the SPA fallback)');

const apiJson = (api.headers.get('content-type') ?? '').includes('json');
check(apiJson, 'API responses are still JSON, not HTML');

const mcp = await fetch(`${ORIGIN}/mcp/o/nobody/s/nothing`, { method: 'POST' });
check(
  mcp.status === 401 || mcp.status === 404,
  'the MCP endpoint still answers, not the SPA shell',
);

const missingApi = await fetch(`${ORIGIN}/api/does-not-exist`);
check(
  !(await missingApi.text()).includes('<div id="root">'),
  'an unknown API path 404s rather than returning HTML to a JSON client',
);

const health = await fetch(`${ORIGIN}/health`).then((r) => r.json());
check(health.ok === true, 'health still responds');

console.log(
  failures === 0 ? '\nM9 acceptance: PASS' : `\nM9 acceptance: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
