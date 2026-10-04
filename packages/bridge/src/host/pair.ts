/**
 * Pairing (ADR 0027): the OAuth device-flow shape. The host asks for a code,
 * opens the browser at /pair, a signed-in person confirms it, and the host
 * receives its device token — once. Nothing is pasted anywhere.
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function openBrowser(url: string): void {
  // Tests and headless machines: print the URL, don't open anything.
  if (process.env.FABRIKKA_NO_BROWSER) return;
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // No browser to open: the URL is printed too.
  }
}

export async function pair(server: string, deviceName: string, log: (...a: unknown[]) => void): Promise<string> {
  const res = await fetch(`${server}/api/devices/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: deviceName }),
  });
  if (!res.ok) throw new Error(`could not start pairing (${res.status}) — is ${server} right?`);
  const { deviceCode, userCode } = (await res.json()) as { deviceCode: string; userCode: string };
  // In the path, not a query: signing in first returns you to the path and would drop a query.
  const url = `${server}/pair/${encodeURIComponent(userCode)}`;
  log('');
  log(`  Connect this computer to Fabrikka: confirm the code ${userCode}`);
  log(`  ${url}`);
  log('');
  openBrowser(url);

  for (;;) {
    await sleep(2000);
    const poll = await fetch(`${server}/api/devices/pair/poll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode }),
    }).catch(() => null);
    if (!poll?.ok) continue;
    const r = (await poll.json()) as { status: string; token?: string; name?: string };
    if (r.status === 'paired' && r.token) {
      log(`  connected as "${r.name}"`);
      return r.token;
    }
    if (r.status === 'expired') throw new Error('the code expired — start the host again to get a new one');
  }
}
