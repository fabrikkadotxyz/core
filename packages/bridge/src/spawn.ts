/**
 * Spawning a headless agent run.
 *
 * Shells out to a binary the user already installed and already authenticated.
 * This module never installs, updates, configures or supervises an agent runtime,
 * and it holds no model credentials — see ARCHITECTURE.md and ADR 0002.
 *
 * Runs are unattended by necessity: a headless agent cannot stop at a permission
 * prompt. What makes that acceptable is that the user started this process, in a
 * directory they chose, with the risk printed on screen (ADR 0011).
 */
import { spawn } from 'node:child_process';
import { summarise, type ActivityLine } from './redact.ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export type Provider = 'claude-code' | 'codex' | string;

/**
 * What an agent may do on this machine (ADR 0027). Enforced by the agent tool
 * itself, with flags verified in real runs (scripts/spikes/m31-policies.mjs):
 *   - read: read files in the folder; nothing that writes exists.
 *   - edit: read and edit files in the folder; no shell, no web, no sub-agents.
 *   - full: anything the tool can do — today's unsandboxed behaviour, opt-in.
 * Either way the run loads Fabrikka's tools and no other MCP server: without
 * --strict-mcp-config it would load the user's own Claude connectors.
 */
export type Policy = 'read' | 'edit' | 'full';

export const POLICIES: Policy[] = ['read', 'edit', 'full'];

/** Providers whose read/edit policies were verified. Codex isn't, yet (ADR 0027). */
export function policyVerified(provider: Provider, policy: Policy): boolean {
  return policy === 'full' || provider === 'claude-code';
}

/** The Claude Code flags for a policy. Exactly the ones the spike verified. */
export function claudePolicyArgs(policy: Policy): string[] {
  const confined = ['--restricted', '--permission-prompts', 'none', '--strict-mcp-config', '--allowedTools', 'mcp__fabrikka'];
  if (policy === 'read') return [...confined, '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep'];
  if (policy === 'edit') return [...confined, '--permission-mode', 'acceptEdits', '--tools', 'Read,Glob,Grep,Edit,Write'];
  // A headless run cannot answer a prompt; full is the explicit, per-folder opt-in.
  return ['--dangerously-skip-permissions'];
}

/**
 * The name the session endpoint is registered under inside a Codex run.
 *
 * Deliberately not plain "fabrikka": `-c` merges into the user's existing
 * config, so a name they might already have used would corrupt their entry.
 */
const CODEX_MCP_KEY = 'fabrikka_session';

export interface SpawnRequest {
  provider: Provider;
  /** Working directory the run executes in. Chosen by the user, not the server. */
  cwd: string;
  prompt: string;
  systemPreamble: string;
  /** Session MCP endpoint plus a run-scoped token, for --mcp-config. */
  mcp?: { url: string; token: string };
  /** Continue a previous run's thread, when the provider supports it. */
  resumeId?: string;
  /** Optional narrowing; unset means the provider's own default. */
  allowedTools?: string[];
  /** What the run may do on this machine (ADR 0027). Unset means full, as before. */
  policy?: Policy;
  onLog?: (line: string) => void;
  /**
   * One step the agent took. Already reduced to a tool name and a short redacted
   * descriptor — the raw call never leaves this module (ADR 0015).
   */
  onActivity?: (line: ActivityLine) => void;
  /** Aborts the run. The server asks for this when a session is paused. */
  signal?: AbortSignal;
}

export interface SpawnResult {
  ok: boolean;
  /** Final assistant text, used for the relay when the agent posted nothing. */
  text: string;
  /** Thread id to resume, when the provider reports one. */
  resumeId?: string;
  error?: string;
}

/** Providers this build knows how to launch. */
export function isSupported(provider: Provider): boolean {
  return provider === 'claude-code' || provider === 'codex';
}

export async function runAgent(req: SpawnRequest): Promise<SpawnResult> {
  // Never run a policy that wasn't verified for this tool as if it were full.
  if (req.policy && !policyVerified(req.provider, req.policy)) {
    return { ok: false, text: '', error: `${req.provider} has no verified "${req.policy}" policy yet (ADR 0027)` };
  }
  if (req.provider === 'codex') return runCodex(req);
  if (req.provider === 'claude-code') return runClaude(req);
  return {
    ok: false,
    text: '',
    error:
      `provider "${req.provider}" cannot be spawned. Supported: claude-code, codex. ` +
      'Attach it as a live session instead.',
  };
}

/* -------------------------------------------------------------------------- */
/* Claude Code                                                                */
/* -------------------------------------------------------------------------- */

async function runClaude(req: SpawnRequest): Promise<SpawnResult> {
  // The MCP config is written to a temp dir, not the user's project, so a run
  // never leaves a token behind in a repo that might be committed.
  const dir = await mkdtemp(join(tmpdir(), 'fabrikka-run-'));
  const configPath = join(dir, 'mcp.json');

  try {
    if (req.mcp) {
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            fabrikka: {
              type: 'http',
              url: req.mcp.url,
              headers: { Authorization: `Bearer ${req.mcp.token}` },
            },
          },
        }),
        { mode: 0o600 },
      );
    }

    const args = [
      '-p',
      req.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--append-system-prompt',
      req.systemPreamble,
      ...claudePolicyArgs(req.policy ?? 'full'),
    ];
    if (req.mcp) args.push('--mcp-config', configPath);
    // A confined policy already names its tools exactly; narrowing it further is
    // only meaningful for full.
    if (req.allowedTools?.length && (req.policy ?? 'full') === 'full') args.push('--allowedTools', ...req.allowedTools);
    if (req.resumeId) args.push('--resume', req.resumeId);

    const out = await execute('claude', args, req, {}, (line) =>
      emitClaudeActivity(line, req),
    );
    if (!out.ok) return out;

    // Activity already streamed above; this pass only extracts the outcome.
    return parseClaudeStream(out.text);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * `claude --output-format stream-json` emits one JSON object per line. The final
 * `result` event carries the answer; assistant text blocks are the fallback when
 * no result event arrives (an aborted run, for instance).
 */
/** One line of `claude --output-format stream-json`, reported as it happens. */
function emitClaudeActivity(line: string, req: SpawnRequest): void {
  if (!line.startsWith('{')) return;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (event.type !== 'assistant') return;

  const message = event.message as { content?: unknown[] } | undefined;
  for (const block of message?.content ?? []) {
    const b = block as { type?: string; name?: string; input?: unknown };
    if (b.type === 'tool_use' && b.name) {
      req.onLog?.(`tool: ${b.name}`);
      // Summarised here, so the raw arguments never leave this process.
      req.onActivity?.(summarise({ name: b.name, args: b.input }));
    }
  }
}

function parseClaudeStream(raw: string): SpawnResult {
  let result = '';
  let sessionId: string | undefined;
  const assistantText: string[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof event.session_id === 'string') sessionId = event.session_id;

    if (event.type === 'result' && typeof event.result === 'string') {
      result = event.result;
    }

    if (event.type === 'assistant') {
      const message = event.message as { content?: unknown[] } | undefined;
      for (const block of message?.content ?? []) {
        const b = block as { type?: string; text?: string };
        if (b.type === 'text' && b.text) assistantText.push(b.text);
      }
    }
  }

  return {
    ok: true,
    text: (result || assistantText.join('\n')).trim(),
    resumeId: sessionId,
  };
}

/* -------------------------------------------------------------------------- */
/* Codex                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Codex.
 *
 * Verified against codex-cli 0.158.0-alpha.2.1. Three things differ from what the
 * older docs suggested, all found by running it:
 *
 * - There is no `--full-auto`. `exec` runs commands without approval by default,
 *   and `--approve-for-me` auto-approves what does need it, under a
 *   workspace-write sandbox. That is a *stronger* posture than Claude Code's
 *   `--dangerously-skip-permissions`, not a weaker one.
 * - MCP servers CAN be injected per-invocation with `-c` overrides, so a Codex
 *   run reaches the session endpoint and posts as itself. The token arrives via
 *   `bearer_token_env_var` — `bearer_token` is rejected — which also keeps it out
 *   of any file on disk.
 * - `-o` writes the final assistant message to a file, which beats reconstructing
 *   it from the event stream.
 *
 * `--skip-git-repo-check` matters because a project directory need not be a repo.
 */
async function runCodex(req: SpawnRequest): Promise<SpawnResult> {
  const dir = await mkdtemp(join(tmpdir(), 'fabrikka-run-'));
  const lastMessagePath = join(dir, 'last.txt');

  try {
    const options = [
      '--json',
      '--skip-git-repo-check',
      // Auto-approve under the workspace-write sandbox, so an unattended run
      // does not stall on a prompt nobody will answer.
      '--approve-for-me',
      '-o',
      lastMessagePath,
    ];

    if (req.mcp) {
      // A distinct key, because `-c` MERGES into whatever the user already has
      // under that name. If they have a stdio `mcp_servers.fabrikka` (adding the
      // bridge to Codex by hand does exactly that), adding a `url` to it fails the
      // whole run with "url is not supported for stdio" — before the model starts,
      // with an error that points at us rather than at the collision.
      options.push(
        '-c',
        `mcp_servers.${CODEX_MCP_KEY}.url="${req.mcp.url}"`,
        '-c',
        `mcp_servers.${CODEX_MCP_KEY}.bearer_token_env_var="FABRIKKA_RUN_TOKEN"`,
      );
    }

    const prompt = `${req.systemPreamble}\n\n${req.prompt}`;

    // No resume for Codex: `codex exec resume` REJECTS --approve-for-me
    // ("unexpected argument"), so a resumed run would stall on the first approval
    // with nobody to answer it. Every Codex run is therefore a fresh thread. The
    // session timeline is the continuity, which is the point of the product.
    const args = ['exec', ...options, prompt];

    const out = await execute(
      'codex',
      args,
      req,
      {
        // Passed in the environment, not on the command line or in a file: it is
        // then invisible to `ps` and leaves nothing behind.
        ...(req.mcp ? { FABRIKKA_RUN_TOKEN: req.mcp.token } : {}),
      },
      (line) => emitCodexActivity(line, req),
    );
    if (!out.ok) return out;

    let threadId: string | undefined;
    const fallback: string[] = [];

    for (const line of out.text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof event.thread_id === 'string') threadId = event.thread_id;

        const item = event.item as
          | {
              type?: string;
              text?: string;
              tool?: string;
              server?: string;
              command?: string;
              arguments?: unknown;
            }
          | undefined;
        if (item?.type === 'agent_message' && item.text) fallback.push(item.text);
        // Activity streamed live in emitCodexActivity; this pass extracts the
        // outcome only.
      } catch {
        continue;
      }
    }

    const finalText = await readFile(lastMessagePath, 'utf8').catch(() => '');
    return {
      ok: true,
      text: (finalText || fallback.join('\n')).trim(),
      // Reported for logging, but never fed back in: see the resume note above.
      resumeId: threadId,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * One line of `codex exec --json`, as an activity line or nothing.
 *
 * Pure, so the stream shapes that cost a real run to discover can be unit-tested
 * against captured lines. Verified against codex-cli 0.158.0-alpha.2.1.
 *
 * **Only `item.started` is read.** Codex reports every item twice — once started,
 * once completed with the same `id` — so reading both showed each step twice.
 * `item.completed` additionally carries `aggregated_output`, the command's real
 * stdout, which is precisely what ADR 0015 says never travels; ignoring the event
 * outright is the safest way not to reach for it.
 */
export function codexActivity(line: string): ActivityLine | null {
  if (!line.startsWith('{')) return null;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event.type !== 'item.started') return null;

  const item = event.item as
    | { type?: string; tool?: string; server?: string; command?: string; arguments?: unknown }
    | undefined;
  if (!item) return null;

  if (item.type === 'mcp_tool_call' && item.tool) {
    return summarise({ name: `${item.server}__${item.tool}`, args: item.arguments });
  }
  if (item.type === 'command_execution') {
    return summarise({ name: 'Bash', args: { command: item.command } });
  }
  return null;
}

function emitCodexActivity(line: string, req: SpawnRequest): void {
  const activity = codexActivity(line);
  if (!activity) return;
  req.onLog?.(`tool: ${activity.tool}`);
  req.onActivity?.(activity);
}

/* -------------------------------------------------------------------------- */
/* Process plumbing                                                           */
/* -------------------------------------------------------------------------- */

const RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run the binary, streaming stdout line by line.
 *
 * `onLine` fires as each complete line arrives, which is what makes activity
 * LIVE. An earlier version parsed the whole buffer after the process exited — the
 * events were all correct and completely useless, arriving after the answer they
 * described.
 */
function execute(
  bin: string,
  args: string[],
  req: SpawnRequest,
  extraEnv: Record<string, string> = {},
  onLine?: (line: string) => void,
): Promise<{ ok: boolean; text: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(resolveBin(bin), args, {
      cwd: req.cwd,
      // Inherit the environment: the binary's own credentials live there, and
      // they are the user's, not ours.
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({
        ok: false,
        text: stdout,
        error: `run exceeded ${RUN_TIMEOUT_MS / 60000} minutes and was stopped`,
      });
    }, RUN_TIMEOUT_MS);

    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      // SIGKILL shortly after: an agent mid-tool-call may ignore SIGTERM, and a
      // kill switch that leaves the process running is not a kill switch.
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      resolve({ ok: false, text: stdout, error: 'run was stopped' });
    };

    // Registered AFTER `timer` exists, since onAbort clears it. And checked
    // eagerly: addEventListener on an already-aborted signal never fires, so a
    // run started just after a pause would otherwise run to completion.
    if (req.signal?.aborted) onAbort();
    else req.signal?.addEventListener('abort', onAbort, { once: true });

    // Lines can straddle chunk boundaries, so hold the tail until it completes.
    let pending = '';
    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (!onLine) return;

      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        text: '',
        error:
          err.message.includes('ENOENT')
            ? `\`${bin}\` is not on PATH. Install it, or run the agent as a live session instead.`
            : err.message,
      });
    });

    child.on('close', (code) => {
      req.signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true, text: stdout });
      resolve({
        ok: false,
        text: stdout,
        error: `${bin} exited ${code}: ${stderr.trim().slice(0, 400) || 'no stderr'}`,
      });
    });
  });
}

/**
 * Resolve an agent binary.
 *
 * `CODEX_BIN` / `CLAUDE_BIN` win, so a user with an unusual install can say so.
 * Otherwise fall back to PATH — except that the Codex desktop app bundles its CLI
 * somewhere PATH never sees, and that is a common enough install to be worth
 * finding rather than failing on.
 */
function resolveBin(bin: string): string {
  const override = process.env[`${bin.toUpperCase().replace(/-/g, '_')}_BIN`];
  if (override) return override;

  if (bin === 'codex') {
    const bundled = join(
      homedir(),
      '.codex/plugins/.plugin-appserver/codex-cli/bin/codex',
    );
    // Only used when the CLI is not on PATH; spawn() would ENOENT otherwise.
    if (!onPath('codex') && existsSync(bundled)) return bundled;
  }

  return bin;
}

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean);
  return dirs.some((d) => existsSync(join(d, bin)));
}
