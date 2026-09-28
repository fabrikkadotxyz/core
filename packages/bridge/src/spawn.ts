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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
 * `codex exec` takes its MCP servers from its own config file rather than a flag,
 * so a Codex run gets no session endpoint and relies on the relay. A real vendor
 * asymmetry, recorded rather than hidden (ADR 0011).
 */
async function runCodex(req: SpawnRequest): Promise<SpawnResult> {
  const args = ['exec'];
  if (req.resumeId) args.push('resume', req.resumeId);
  args.push('--json', '--full-auto', `${req.systemPreamble}\n\n${req.prompt}`);

  const out = await execute('codex', args, req);
  if (!out.ok) return out;

  let text = '';
  let threadId: string | undefined;

  for (const line of out.text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof event.thread_id === 'string') threadId = event.thread_id;
      const item = event.item as { type?: string; text?: string } | undefined;
      if (item?.type === 'agent_message' && item.text) text += item.text + '\n';
      if (typeof event.text === 'string' && event.type === 'agent_message') {
        text += event.text + '\n';
      }
    } catch {
      continue;
    }
  }

  return { ok: true, text: text.trim(), resumeId: threadId };
}

/* -------------------------------------------------------------------------- */
/* Process plumbing                                                           */
/* -------------------------------------------------------------------------- */

const RUN_TIMEOUT_MS = 10 * 60 * 1000;

function execute(
  bin: string,
  args: string[],
  req: SpawnRequest,
): Promise<{ ok: boolean; text: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: req.cwd,
      // Inherit the environment: the binary's own credentials live there, and
      // they are the user's, not ours.
      env: process.env,
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
