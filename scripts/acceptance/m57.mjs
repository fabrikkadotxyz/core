/**
 * M57 acceptance: apps for every desktop (ADR 0056).
 *
 * From the source: four platforms with pinned Node and a bundle each, one
 * workflow on four runners, the Docker build argument, the installers'
 * platform handling, the Devices page switch. Against the server: the
 * Windows installer is served with the address written in and the same
 * guards as the shell one; the manifest lists apps by platform; a listed
 * file and its checksum are served, an unlisted one is not.
 */
import { existsSync, readFileSync } from 'node:fs';

const CORE = process.env.FABRIKKA_URL ?? 'http://localhost:9090';
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};
const read = (p) => readFileSync(p, 'utf8');

/* ------------------------------------------------ 1. the source */

const fetchNode = read('apps/desktop/scripts/fetch-node.mjs');
for (const t of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']) check(new RegExp(`'${t}': \\{[\\s\\S]*?sha256: '[0-9a-f]{64}'`).test(fetchNode), `a pinned, checksummed Node for ${t}`);
check(/triple: 'x86_64-pc-windows-msvc',[\s\S]*?exe: '\.exe'/.test(fetchNode), "Windows's sidecar ends in .exe");
const pkg = read('apps/desktop/scripts/package.mjs');
check(/'darwin-x64': \{ platform: 'darwin-x64', bundle: 'app'/.test(pkg) && /'linux-x64': \{ platform: 'linux-x64', bundle: 'appimage'/.test(pkg) && /'win32-x64': \{ platform: 'windows-x64', bundle: 'nsis'/.test(pkg), 'ONE APP PER PLATFORM: a zipped .app, an AppImage, an NSIS installer');
check(/apps-manifest\.mjs/.test(pkg) && existsSync('apps/desktop/scripts/apps-manifest.mjs'), 'the package writes its .meta.json and regenerates apps.json');
check(JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json')).bundle.targets.includes('nsis'), 'nsis is a bundle target');
const wf = read('.github/workflows/desktop.yml');
check(/tags: \['app-v\*'\]/.test(wf) && /workflow_dispatch/.test(wf), 'THE WORKFLOW RUNS ON A TAG app-v*, or by hand');
for (const r of ['macos-15', 'macos-15-intel', 'ubuntu-22.04', 'windows-latest']) check(wf.includes(`os: ${r}`), `…on ${r}`);
check(/softprops\/action-gh-release/.test(wf) && /apps-manifest\.mjs dist-app/.test(wf), '…merges apps.json and attaches everything to a release of the tag');
check(/ARG FABRIKKA_APPS_URL=""/.test(read('docker/Dockerfile')) && /fetch-apps\.mjs/.test(read('docker/Dockerfile')) && existsSync('scripts/fetch-apps.mjs'), 'THE IMAGE TAKES THE APPS FROM A RELEASE, checksums verified, when FABRIKKA_APPS_URL is given');
check(/sha !== app\.sha256\) throw/.test(read('scripts/fetch-apps.mjs')), '…and refuses a file whose checksum differs');
const rs = read('apps/desktop/src-tauri/src/main.rs');
check(/let sep = if cfg!\(windows\) \{ ';' \} else \{ ':' \};/.test(rs) && /APPDATA[\s\S]*?npm/.test(rs), "the host's search PATH uses the platform's separator and Windows's npm folder");
const client = read('apps/server/src/client.ts');
check(/'darwin-x64': 'Fabrikka-macos-x64\.zip'/.test(client) && /'linux-x64': 'Fabrikka-linux-x64\.AppImage'/.test(client) && /'windows-x64': 'Fabrikka-windows-x64-setup\.exe'/.test(client), 'the server knows the four files');
check(/Darwin-x86_64\) file=\$\{APP_PLATFORMS\['darwin-x64'\]\}/.test(client) && /Linux-x86_64\) file=\$\{APP_PLATFORMS\['linux-x64'\]\}/.test(client) && /install_app_linux\(\)/.test(client) && /fabrikka\.desktop/.test(client), 'install.sh --app reads uname: the Mac zip, or the AppImage with a launcher entry');
const sh = await (await fetch(`${CORE}/install.sh`)).text();
check(/Linux-x86_64\) file=Fabrikka-linux-x64\.AppImage/.test(sh) && /no desktop app for \$os on \$arch yet/.test(sh), '…and the served script names the files');
const devices = read('apps/web/src/pages/DevicesPage.tsx');
check(/macOS · Linux/.test(devices) && /Windows/.test(devices) && /browserOs/.test(devices), 'Your devices shows the line for your platform, with a switch');
check(/M57 — Apps for every desktop/.test(read('docs/roadmap.md')) && /\| \[0056\]\(0056-apps-for-every-desktop/.test(read('docs/decisions/README.md')) && /install\.ps1/.test(read('docs/operations.md')) && /install\.ps1/.test(read('docs/security.md')), 'the roadmap, the ADR index, operations and security say so');

/* ------------------------------------------------ 2. the server */

const res = await fetch(`${CORE}/install.ps1`);
const ps = await res.text();
check(res.status === 200 && res.headers.get('content-type')?.startsWith('text/plain'), 'THE WINDOWS INSTALLER IS SERVED as plain text');
check(ps.includes(`$Server = '${CORE}'`) && ps.trimEnd().endsWith('Main'), 'with this instance\'s address written in, run from its last line');
check(/notmatch '\^https:\/\/'/.test(ps) && /localhost\|127\\\.0\\\.0\\\.1/.test(ps), 'it refuses plain http:// except localhost');
check(/Get-FileHash/.test(ps) && /doesn't match its checksum, so nothing was installed/.test(ps), 'the checksum must match or nothing is installed');
check(!/-Verb RunAs/.test(ps) && !/Start-Process .*-Verb/.test(ps) && /'\/S'/.test(ps), 'nothing elevated: a per-user silent install');
check(/FABRIKKA_INSTALL -eq 'client'/.test(ps) && /fabrikka\.cmd/.test(ps) && /'User'\)/.test(ps), "$env:FABRIKKA_INSTALL='client' installs the command-line client with a shim on the user's PATH");
check(!/`/.test(ps), 'no backticks: nothing PowerShell would read as an escape');
const api = await (await fetch(`${CORE}/api/client`)).json();
check(api.installCommandWindows === `irm ${CORE}/install.ps1 | iex` && Array.isArray(api.platforms), '"Your devices" gets the Windows line too, and which platforms have an app');
const manifest = await (await fetch(`${CORE}/downloads/manifest.json`)).json();
check(Array.isArray(manifest.apps) && manifest.apps.every((a) => /^(darwin-(arm64|x64)|linux-x64|windows-x64)$/.test(a.platform) && /^[0-9a-f]{64}$/.test(a.sha256) && a.url.startsWith(`${CORE}/downloads/`)), 'THE MANIFEST LISTS APPS BY PLATFORM, each with its checksum and address');
if (manifest.apps.length > 0) {
  const a = manifest.apps[0];
  const sums = await fetch(`${a.url}.sha256`);
  check(sums.status === 200 && (await sums.text()).startsWith(a.sha256), `a listed file's checksum is served (${a.platform})`);
  const head = await fetch(a.url, { method: 'HEAD' });
  check(head.status === 200 && Number(head.headers.get('content-length')) === a.size, '…and the file itself, with its size');
  const win = await fetch(`${CORE}/api/client`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }).then((r) => r.json());
  check(win.appUrl === null || win.appUrl.endsWith('Fabrikka-windows-x64-setup.exe'), 'a Windows browser is offered the Windows app, or none');
} else {
  console.log('note  this instance serves no app: the file checks are skipped');
}
check((await fetch(`${CORE}/downloads/Fabrikka-nope.zip`)).status === 404 && (await fetch(`${CORE}/downloads/..%2Fapps.json`)).status === 404, 'an unlisted file is not served');

console.log(failures ? `\n${failures} FAILED` : '\nM57 checks passed');
process.exit(failures ? 1 : 0);
