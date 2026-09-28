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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export type Provider = 'claude-code' | 'codex' | string;

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
  onLog?: (line: string) => void;
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
      // A headless run cannot answer a prompt. See ADR 0011 for why this is
      // acceptable here and nowhere else.
      '--dangerously-skip-permissions',
    ];
    if (req.mcp) args.push('--mcp-config', configPath);
    if (req.allowedTools?.length) args.push('--allowedTools', ...req.allowedTools);
    if (req.resumeId) args.push('--resume', req.resumeId);

    const out = await execute('claude', args, req);
    if (!out.ok) return out;

    return parseClaudeStream(out.text, req.onLog);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * `claude --output-format stream-json` emits one JSON object per line. The final
 * `result` event carries the answer; assistant text blocks are the fallback when
 * no result event arrives (an aborted run, for instance).
 */
function parseClaudeStream(raw: string, onLog?: (l: string) => void): SpawnResult {
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
        const b = block as { type?: string; text?: string; name?: string };
        if (b.type === 'text' && b.text) assistantText.push(b.text);
        if (b.type === 'tool_use' && b.name) onLog?.(`tool: ${b.name}`);
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
      options.push(
        '-c',
        `mcp_servers.fabrikka.url="${req.mcp.url}"`,
        '-c',
        'mcp_servers.fabrikka.bearer_token_env_var="FABRIKKA_RUN_TOKEN"',
      );
    }

    const prompt = `${req.systemPreamble}\n\n${req.prompt}`;
    const args = req.resumeId
      ? ['exec', 'resume', ...options, req.resumeId, prompt]
      : ['exec', ...options, prompt];

    const out = await execute('codex', args, req, {
      // Passed in the environment, not on the command line or in a file: it is
      // then invisible to `ps` and leaves nothing behind.
      ...(req.mcp ? { FABRIKKA_RUN_TOKEN: req.mcp.token } : {}),
    });
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
          | { type?: string; text?: string; tool?: string; server?: string }
          | undefined;
        if (item?.type === 'agent_message' && item.text) fallback.push(item.text);
        if (item?.type === 'mcp_tool_call' && item.tool) {
          req.onLog?.(`tool: ${item.server}/${item.tool}`);
        }
        if (item?.type === 'command_execution') req.onLog?.('tool: shell');
      } catch {
        continue;
      }
    }

    const finalText = await readFile(lastMessagePath, 'utf8').catch(() => '');
    return {
      ok: true,
      text: (finalText || fallback.join('\n')).trim(),
      resumeId: threadId,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Process plumbing                                                           */
/* -------------------------------------------------------------------------- */

const RUN_TIMEOUT_MS = 10 * 60 * 1000;

function execute(
  bin: string,
  args: string[],
  req: SpawnRequest,
  extraEnv: Record<string, string> = {},
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

    child.stdout.on('data', (d) => {
      stdout += d.toString();
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
