/**
 * `fabrikka host` — the local host (M31, ADR 0027).
 *
 * Paired once with your account, it runs your agents in folders granted on this
 * machine. The server sends bindings ("this agent, in grant #2") with a fresh
 * token each; the host resolves the grant to a folder and a policy from its own
 * config and opens one ordinary runner connection per binding. The server can
 * never choose a folder, a command or a permission.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { policyVerified } from '../spawn.ts';
import { startRunner, type RunnerHandle } from '../watch.ts';
import { HOST_HOME, loadHostConfig, saveHostConfig, type HostConfig } from './config.ts';
import { startControl } from './control.ts';
import { openBrowser, pair } from './pair.ts';
import { VERSION } from '../version.ts';

export interface Binding {
  id: string;
  grantId: string;
  provider: string;
  agent: { displayName: string };
  session: { title: string; ownerSlug: string; publicId: string };
  mcpUrl: string;
  bridgeUrl: string;
  token: string;
}

export interface RunLogEntry {
  at: string;
  agent: string;
  session: string;
  folder: string;
  policy: string;
  event: 'started' | 'done' | 'failed' | 'stopped' | 'refused';
  detail?: string;
}

/** Agent tools installed here — reported to the server so it can offer them. */
export function installedProviders(): string[] {
  const has = (cmd: string) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;
  return [has('claude') && 'claude-code', has('codex') && 'codex'].filter(Boolean) as string[];
}

export class Host {
  cfg: HostConfig;
  private ws: WebSocket | null = null;
  private runners = new Map<string, { handle: RunnerHandle; binding: Binding; grantKey: string }>();
  private bindings = new Map<string, Binding>();
  private retry = 1000;
  private closed = false;
  readonly log: RunLogEntry[] = [];
  connected = false;
  providers = installedProviders();
  /** The client version the server serves (M33): newer than ours means "update available". */
  latestVersion: string | null = null;

  constructor(
    cfg: HostConfig,
    private say: (...a: unknown[]) => void,
  ) {
    this.cfg = cfg;
  }

  /** Grants as the server sees them: ids, labels and installed tools. No paths. */
  private reportedGrants() {
    return this.cfg.grants.map((g) => ({ id: g.id, label: g.label, providers: this.providers }));
  }

  connect(): void {
    if (this.closed || !this.cfg.deviceToken) return;
    const url = this.cfg.server.replace(/^http/, 'ws') + '/host';
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${this.cfg.deviceToken}` } });
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 1000;
      this.connected = true;
      ws.send(JSON.stringify({ type: 'grants', grants: this.reportedGrants() }));
      this.say(`connected to ${this.cfg.server}`);
    });
    ws.on('message', (data) => {
      let frame: { type?: string; bindings?: Binding[]; binding?: Binding; code?: string; version?: string };
      try {
        frame = JSON.parse(String(data));
      } catch {
        return;
      }
      if (frame.type === 'bindings' && frame.bindings) this.reconcile(frame.bindings);
      if (frame.type === 'binding' && frame.binding) this.add(frame.binding);
      if (frame.type === 'client' && frame.version) this.clientVersion(frame.version);
      if (frame.type === 'revoked' || (frame.type === 'error' && frame.code === 'unauthenticated')) this.forget();
    });
    ws.on('close', () => {
      this.connected = false;
      if (this.closed) return;
      // Reconnect with backoff; on reconnect every binding gets a fresh token.
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 30_000);
    });
    ws.on('error', () => {});
  }

  /** The server announced the client it serves. Say so if it isn't us; never update ourselves (ADR 0030). */
  private clientVersion(version: string): void {
    const was = this.updateAvailable();
    this.latestVersion = version;
    if (this.updateAvailable() && !was) {
      this.say(`update available: ${VERSION} → ${version}. Run \`fabrikka update\`, then start the host again.`);
    }
  }

  updateAvailable(): boolean {
    // A build from source ("dev") is whatever the developer made it; nothing to offer.
    return VERSION !== 'dev' && this.latestVersion !== null && this.latestVersion !== VERSION;
  }

  /** The device was revoked (or its token is no longer valid): stop and unpair. */
  private forget(): void {
    this.say('this computer was disconnected from Fabrikka — run `fabrikka host` again to reconnect');
    this.closed = true;
    this.stopAll();
    for (const r of this.runners.values()) r.handle.stop();
    this.runners.clear();
    this.cfg.deviceToken = undefined;
    saveHostConfig(this.cfg);
    this.ws?.close();
  }

  private reconcile(list: Binding[]): void {
    // A reconnect re-mints every token, so every runner restarts with its new one.
    for (const r of this.runners.values()) r.handle.stop();
    this.runners.clear();
    this.bindings = new Map(list.map((b) => [b.id, b]));
    for (const b of list) void this.start(b);
  }

  private add(b: Binding): void {
    this.bindings.set(b.id, b);
    void this.start(b);
  }

  private record(e: Omit<RunLogEntry, 'at'>): void {
    const entry = { at: new Date().toISOString(), ...e };
    this.log.unshift(entry);
    this.log.length = Math.min(this.log.length, 200);
    try {
      appendFileSync(join(HOST_HOME, 'host.log'), JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch {
      // The log is for the user; a full disk mustn't stop a run.
    }
  }

  /**
   * Start one binding — after checking it against THIS machine's config. A grant
   * that's gone, a missing folder, an uninstalled tool or an unverified policy
   * means no runner at all.
   */
  private async start(b: Binding): Promise<void> {
    const grant = this.cfg.grants.find((g) => g.id === b.grantId);
    const where = { agent: b.agent.displayName, session: b.session.title, folder: grant?.label ?? '?', policy: grant?.policy ?? '?' };
    const refuse = (detail: string) => {
      this.say(`not running @${b.agent.displayName}: ${detail}`);
      this.record({ ...where, event: 'refused', detail });
    };
    if (!grant) return refuse('that folder is no longer granted on this computer');
    if (!existsSync(grant.path)) return refuse(`${grant.path} no longer exists`);
    if (!this.providers.includes(b.provider)) return refuse(`${b.provider} is not installed here`);
    if (!policyVerified(b.provider, grant.policy)) return refuse(`${b.provider} has no verified "${grant.policy}" policy`);

    const handle = await startRunner({
      config: { mcpUrl: b.mcpUrl, bridgeUrl: b.bridgeUrl, token: b.token },
      dir: grant.path,
      provider: b.provider,
      policy: grant.policy,
      log: (...a) => this.say(`[@${b.agent.displayName}]`, ...a),
      onRunStart: (i) => this.record({ ...where, event: 'started', detail: `@${i.author}: ${i.preview}` }),
      onRunEnd: (i) => this.record({ ...where, event: i.status, detail: i.error }),
    }).catch((err) => {
      refuse((err as Error).message);
      return null;
    });
    if (handle) this.runners.set(b.id, { handle, binding: b, grantKey: `${grant.path}|${grant.policy}` });
  }

  /** A grant changed here: tell the server, and restart the runners it affects. */
  grantsChanged(): void {
    saveHostConfig(this.cfg);
    this.ws?.send(JSON.stringify({ type: 'grants', grants: this.reportedGrants() }));
    for (const [id, r] of this.runners) {
      const g = this.cfg.grants.find((x) => x.id === r.binding.grantId);
      if (!g || `${g.path}|${g.policy}` !== r.grantKey) {
        // A tightened policy must take effect now, not after the current run.
        if (r.handle.running) {
          this.record({
            agent: r.binding.agent.displayName,
            session: r.binding.session.title,
            folder: g?.label ?? '?',
            policy: g?.policy ?? '?',
            event: 'stopped',
            detail: g ? "the folder's policy changed — stopped the run in progress" : 'the folder was removed — stopped the run in progress',
          });
        }
        r.handle.stop();
        this.runners.delete(id);
        void this.start(r.binding);
      }
    }
  }

  /** Stop every run now. Connections stay; the next mention starts a new run. */
  stopAll(): void {
    for (const r of this.runners.values()) r.handle.abort();
  }

  state() {
    return {
      server: this.cfg.server,
      deviceName: this.cfg.deviceName,
      connected: this.connected,
      version: VERSION,
      latestVersion: this.latestVersion,
      updateAvailable: this.updateAvailable(),
      providers: this.providers,
      grants: this.cfg.grants,
      agents: [...this.bindings.values()].map((b) => ({
        id: b.id,
        agent: b.agent.displayName,
        session: b.session.title,
        folder: this.cfg.grants.find((g) => g.id === b.grantId)?.label ?? null,
        running: this.runners.get(b.id)?.handle.running ?? false,
        active: this.runners.has(b.id),
      })),
      log: this.log.slice(0, 50),
    };
  }
}

export async function runHost(argv: string[], say: (...a: unknown[]) => void): Promise<void> {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cfg = loadHostConfig(flag('server'));
  if (!cfg.deviceToken) {
    cfg.deviceToken = await pair(cfg.server, cfg.deviceName, say);
    saveHostConfig(cfg);
  }
  saveHostConfig(cfg);

  const host = new Host(cfg, say);
  host.connect();
  const control = await startControl(host, say);
  say(`folders and runs: ${control.url}`);
  if (cfg.grants.length === 0 || argv.includes('--open')) openBrowser(control.url);

  const shutdown = () => {
    host.stopAll();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
