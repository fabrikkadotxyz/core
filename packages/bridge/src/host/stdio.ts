/**
 * Control over stdio (M34, ADR 0031): how the desktop app talks to the host it
 * runs. No page, no port: one JSON object per line on stdin, one per line on
 * stdout. stdout carries only this — every log goes to stderr.
 *
 * The contract is in docs/protocol.md ("Controlling a host over stdio").
 */
import { createInterface } from 'node:readline';
import type { Host } from './host.ts';
import { addGrant, removeGrant, setTool, updateGrant } from './ops.ts';

export function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

/**
 * Opened before pairing, so the app's questions are answered — and the app
 * closing is noticed — from the first moment. `attach` hands it the host once
 * this computer is paired.
 */
export function startStdioControl(): { attach(host: Host): void } {
  let host: Host | null = null;
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let req: { id?: unknown; op?: string; [k: string]: unknown };
    try {
      req = JSON.parse(line);
    } catch {
      return send({ id: null, ok: false, error: 'not JSON' });
    }
    const id = req.id ?? null;
    const reply = (r: { ok: true; [k: string]: unknown } | { ok: false; error: string }) => send({ id, ...r });
    if (!host) return reply({ ok: false, error: 'waiting for you to confirm this computer on the pairing page' });
    switch (req.op) {
      case 'state':
        return reply({ ok: true, state: host.state() });
      case 'grant': {
        const added = addGrant(host, { path: req.path as string, label: req.label as string, policy: req.policy });
        return added.ok ? reply({ ok: true, grant: added.value }) : reply(added);
      }
      case 'policy': {
        const done = updateGrant(host, String(req.grantId), { policy: req.policy, label: req.label as string | undefined });
        return done.ok ? reply({ ok: true }) : reply(done);
      }
      case 'remove': {
        const done = removeGrant(host, String(req.grantId));
        return done.ok ? reply({ ok: true }) : reply(done);
      }
      case 'tool': {
        const done = setTool(host, String(req.tool), req.enabled === true);
        return done.ok ? reply({ ok: true }) : reply(done);
      }
      case 'stop':
        host.stopAll();
        return reply({ ok: true });
      default:
        return reply({ ok: false, error: `unknown op: ${String(req.op)}` });
    }
  });
  // The app closed our stdin: it's gone, so are we.
  lines.on('close', () => {
    host?.stopAll();
    process.exit(0);
  });
  return {
    attach(h) {
      host = h;
    },
  };
}
