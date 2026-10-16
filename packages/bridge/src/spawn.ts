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
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export type Provider = 'claude-code' | 'codex' | 'opencode' | string;

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

/**
 * Every policy is verified for each tool: Claude Code in M31 (ADR 0027), Codex
 * in M35 (ADR 0032) — whose read/edit confine writes, network and its other
 * tools, but not reads, as its picker says — and OpenCode in M16 (ADR 0047),
 * whose per-run permission config confines reads too.
 */
export function policyVerified(provider: Provider, policy: Policy): boolean {
  // ADR 0054: an arbitrary command is confined by nothing, so it is Full only.
  if (provider === 'command') return policy === 'full';
  // ADR 0055: Antigravity's own modes, verified by the disk (plan, accept-edits, skip-permissions).
  return POLICIES.includes(policy) && (provider === 'claude-code' || provider === 'codex' || provider === 'opencode' || provider === 'antigravity');
}

/** Codex features that reach beyond its sandboxed shell: off in read and edit (ADR 0032). */
const CODEX_OFF = ['computer_use', 'browser_use', 'browser_use_external', 'in_app_browser', 'apps', 'plugins', 'remote_plugin'];

/** The Codex flags for a policy. Exactly the ones scripts/spikes/m35-codex-policies.mjs verified. */
export function codexPolicyArgs(policy: Policy): string[] {
  // Today's runner behaviour: auto-approve inside the workspace-write sandbox.
  if (policy === 'full') return ['--approve-for-me'];
  const common = ['-c', 'approval_policy="never"', ...CODEX_OFF.flatMap((f) => ['--disable', f])];
  if (policy === 'read') return ['-s', 'read-only', ...common];
  return ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false', ...common];
}

/**
 * A fresh Codex home for one run: a link to the user's sign-in and nothing else,
 * so none of their MCP servers (some run outside Codex's sandbox — computer
 * control, a JavaScript REPL), plugins, hooks or memories load. Inside `dir`,
 * which the run deletes when it ends. ADR 0032, finding 5.
 */
async function isolatedCodexHome(dir: string): Promise<string> {
  const home = join(dir, 'codex-home');
  await mkdir(home, { mode: 0o700 });
  const auth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  // Signed in with an API key instead? Then there's no auth.json, and the key in
  // the environment still works.
  if (existsSync(auth)) await symlink(auth, join(home, 'auth.json'));
  return home;
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
  /** ADR 0054: where this run may report, and as which run. Set as FABRIKKA_REPORT_URL, FABRIKKA_RUN_TOKEN, FABRIKKA_RUN_ID. */
  report?: { url: string; token: string; runId: string };
  /** ADR 0054: provider `command`: the argv to run, with the preamble and prompt on stdin. */
  command?: string[];
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
  return provider === 'claude-code' || provider === 'codex' || provider === 'opencode' || provider === 'antigravity' || provider === 'command';
}

export async function runAgent(req: SpawnRequest): Promise<SpawnResult> {
  // Never run a policy that wasn't verified for this tool as if it were full.
  if (req.policy && !policyVerified(req.provider, req.policy)) {
    return { ok: false, text: '', error: `${req.provider} has no verified "${req.policy}" policy yet (ADR 0027)` };
  }
  if (req.provider === 'codex') return runCodex(req);
  if (req.provider === 'opencode') return runOpencode(req);
  if (req.provider === 'claude-code') return runClaude(req);
  if (req.provider === 'antigravity') return runAntigravity(req);
  if (req.provider === 'command') return runCommand(req);
  return {
    ok: false,
    text: '',
    error:
      `provider "${req.provider}" cannot be spawned. Supported: claude-code, codex, opencode, antigravity, command. ` +
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
    const policy = req.policy ?? 'full';
    const options = [
      '--json',
      '--skip-git-repo-check',
      // The folder's policy (ADR 0032). `full` is today's --approve-for-me.
      ...codexPolicyArgs(policy),
      '-c',
      'web_search="disabled"',
      '-o',
      lastMessagePath,
    ];
    // read and edit: none of the user's own Codex setup (ADR 0032, finding 4).
    const codexHome = policy === 'full' ? null : await isolatedCodexHome(dir);

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
        // Every MCP call needs approval, and prompts are off: pre-approve the
        // session's own tools, and only them (ADR 0032, finding 6).
        '-c',
        `mcp_servers.${CODEX_MCP_KEY}.default_tools_approval_mode="approve"`,
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
        ...(codexHome ? { CODEX_HOME: codexHome } : {}),
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
/* OpenCode                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The name the session endpoint is registered under inside an OpenCode run.
 * The same key as Codex, for the same reason: config merges by key, and a
 * project's own opencode.json may already name a `fabrikka` server. Tools
 * arrive as `fabrikka_session_<tool>` (ADR 0047).
 */
const OPENCODE_MCP_KEY = 'fabrikka_session';

/** OpenCode tools that reach beyond reading the folder: off in read (ADR 0047). */
const OPENCODE_OFF_READ = ['bash', 'edit', 'write', 'patch', 'webfetch', 'websearch', 'task'];
/** In edit, the editing tools come back; the shell, the web and sub-agents stay off. */
const OPENCODE_OFF_EDIT = ['bash', 'webfetch', 'websearch', 'task'];

/**
 * The OpenCode config for a policy, passed per run as OPENCODE_CONFIG_CONTENT
 * and never written to the folder. Exactly what
 * scripts/spikes/m16-opencode-policies.mjs verified by the disk (opencode 1.18.35):
 *
 * - `tools` removes a tool outright: the model has no shell to ask for.
 * - `permission` is matched by name, last rule wins, so `*` comes first. It
 *   covers MCP tools too, which is what keeps a project's own servers out of a
 *   confined run; the session's are re-admitted by prefix.
 * - `external_directory: deny` refuses reads and writes outside the folder.
 * - A rule that would prompt is auto-rejected in headless mode, so a forgotten
 *   key fails closed.
 *
 * `full` carries only the session's server: the user's own config applies, and
 * `--auto` approves whatever it doesn't deny.
 */
export function opencodePolicyConfig(policy: Policy, mcp?: { url: string }): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (mcp) {
    config.mcp = {
      [OPENCODE_MCP_KEY]: {
        type: 'remote',
        url: mcp.url,
        enabled: true,
        // Substituted by OpenCode from the environment: the token is in no file
        // and on no command line.
        headers: { Authorization: 'Bearer {env:FABRIKKA_RUN_TOKEN}' },
      },
    };
  }
  if (policy === 'full') return config;

  config.tools = Object.fromEntries((policy === 'read' ? OPENCODE_OFF_READ : OPENCODE_OFF_EDIT).map((t) => [t, false]));
  config.permission = {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    ...(policy === 'edit' ? { edit: 'allow' } : {}),
    external_directory: 'deny',
    [`${OPENCODE_MCP_KEY}_*`]: 'allow',
  };
  return config;
}

/** The `opencode run` flags for a policy: only `full` approves on its own. */
export function opencodePolicyArgs(policy: Policy): string[] {
  return policy === 'full' ? ['--auto'] : [];
}

/**
 * OpenCode.
 *
 * Verified against opencode 1.18.35 (ADR 0047). `run --format json` prints one
 * event per line, each carrying the `sessionID`; `-s` resumes it, and unlike
 * Codex the policy is config rather than a flag a resume would reject, so
 * resuming is used. No sign-in is required: without a provider OpenCode runs on
 * its own free models, slowly.
 */
async function runOpencode(req: SpawnRequest): Promise<SpawnResult> {
  const dir = await mkdtemp(join(tmpdir(), 'fabrikka-run-'));

  try {
    const policy = req.policy ?? 'full';
    // read and edit: an empty config directory, so none of the user's own
    // OpenCode servers, agents or commands load (ADR 0047, finding 9). `full`
    // keeps theirs, as it does for Codex.
    const configHome = policy === 'full' ? null : join(dir, 'xdg');
    if (configHome) await mkdir(join(configHome, 'opencode'), { recursive: true, mode: 0o700 });

    // --pure: none of the user's plugins, which run outside the permission layer.
    // --dir: OpenCode takes its working directory from the inherited PWD variable,
    // not from the process's real cwd (ADR 0047, finding 10). A child started with
    // `cwd` alone would run in the host's own directory. Both are set, below.
    const args = ['run', '--format', 'json', '--pure', '--dir', req.cwd, ...opencodePolicyArgs(policy)];
    if (req.resumeId) args.push('-s', req.resumeId);
    args.push(`${req.systemPreamble}\n\n${req.prompt}`);

    const out = await execute(
      'opencode',
      args,
      req,
      {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodePolicyConfig(policy, req.mcp)),
        PWD: req.cwd,
        ...(req.mcp ? { FABRIKKA_RUN_TOKEN: req.mcp.token } : {}),
        ...(configHome ? { XDG_CONFIG_HOME: configHome } : {}),
      },
      (line) => emitOpencodeActivity(line, req),
    );

    // Activity streamed above; this pass extracts the outcome: the session to
    // resume, the text of the last message, and any error event.
    let sessionId: string | undefined;
    let error: string | undefined;
    let lastMessage: string | undefined;
    const texts = new Map<string, string[]>();
    for (const line of out.text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof event.sessionID === 'string') sessionId = event.sessionID;
      if (event.type === 'error') {
        const e = event.error as { name?: string; data?: { message?: string } } | undefined;
        error = e?.data?.message ?? e?.name ?? 'OpenCode reported an error';
      }
      if (event.type === 'text') {
        const part = event.part as { messageID?: string; text?: string } | undefined;
        if (!part?.text) continue;
        const key = part.messageID ?? '';
        lastMessage = key;
        texts.set(key, [...(texts.get(key) ?? []), part.text]);
      }
    }
    // A free model sometimes leaks its reasoning delimiter into the text.
    const text = (texts.get(lastMessage ?? '') ?? []).join('\n').replace(/^(?:<\/?think>\s*)+/, '').trim();

    if (!out.ok) return { ok: false, text: '', error: error ?? out.error, resumeId: sessionId };
    if (error && !text) return { ok: false, text: '', error, resumeId: sessionId };
    return { ok: true, text, resumeId: sessionId };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** OpenCode's tool names, as the summariser knows them. Anything else is named and nothing more. */
const OPENCODE_TOOLS: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  patch: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  bash: 'Bash',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  task: 'Task',
  todowrite: 'TodoWrite',
};

/**
 * One line of `opencode run --format json`, as an activity line or nothing.
 *
 * Pure, so the stream shape can be unit-tested against captured lines. Verified
 * against opencode 1.18.35: one `tool_use` event per call, carrying the tool's
 * name and input in `part.state`. **`part.state.output` is the tool's result and
 * is never read** (ADR 0015). OpenCode names its arguments differently from
 * Claude Code (`filePath`, not `file_path`), so the one descriptor each
 * summariser case reads is mapped here, and only that one.
 */
export function opencodeActivity(line: string): ActivityLine | null {
  if (!line.startsWith('{')) return null;

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event.type !== 'tool_use') return null;

  const part = event.part as { tool?: string; state?: { input?: Record<string, unknown> } } | undefined;
  if (!part?.tool) return null;
  const input = part.state?.input ?? {};
  const name = OPENCODE_TOOLS[part.tool];
  // MCP tools (fabrikka_session_post_message) and anything unknown: the name only.
  if (!name) return summarise({ name: part.tool });

  const args =
    name === 'Bash'
      ? { command: input.command }
      : name === 'Glob' || name === 'Grep'
        ? { pattern: input.pattern }
        : name === 'WebFetch'
          ? { url: input.url }
          : name === 'WebSearch'
            ? { query: input.query }
            : name === 'Task' || name === 'TodoWrite'
              ? {}
              : { file_path: input.filePath };
  return summarise({ name, args });
}

function emitOpencodeActivity(line: string, req: SpawnRequest): void {
  const activity = opencodeActivity(line);
  if (!activity) return;
  req.onLog?.(`tool: ${activity.tool}`);
  req.onActivity?.(activity);
}

/* -------------------------------------------------------------------------- */
/* Antigravity (ADR 0055)                                                     */
/* -------------------------------------------------------------------------- */

/** The agy flags for a policy. Exactly what scripts/spikes/m16-antigravity-policies.mjs verified (agy 1.3.5). */
export function antigravityPolicyArgs(policy: Policy): string[] {
  if (policy === 'read') return ['--mode', 'plan'];
  if (policy === 'edit') return ['--mode', 'accept-edits'];
  return ['--dangerously-skip-permissions'];
}

/**
 * Antigravity CLI.
 *
 * `agy -p --output-format stream-json` prints one event per line; `result`
 * carries the answer and the conversation id, `--conversation` resumes it. The
 * session's tools reach a run only through a user-level stdio entry (`agy mcp
 * add -- fabrikka fabrikka connect`) that inherits the run's environment, and
 * only in Full: headless runs deny `call_mcp_tool` under plan and accept-edits.
 * The runner posts the answer for a run that posted nothing, as for any tool.
 */
async function runAntigravity(req: SpawnRequest): Promise<SpawnResult> {
  const policy = req.policy ?? 'full';
  const args = ['-p', `${req.systemPreamble}\n\n${req.prompt}`, '--output-format', 'stream-json', '--disable-slash-commands', ...antigravityPolicyArgs(policy)];
  if (req.resumeId) args.push('--conversation', req.resumeId);

  const out = await execute(
    'agy',
    args,
    req,
    // The user-level `fabrikka` entry, if any, binds to this room and run through these.
    req.mcp ? { FABRIKKA_URL: req.mcp.url, FABRIKKA_TOKEN: req.mcp.token } : {},
    (line) => emitAntigravityActivity(line, req),
  );

  let conversationId: string | undefined;
  let response: string | undefined;
  let status: string | undefined;
  let error: string | undefined;
  for (const line of out.text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.event === 'init') conversationId = (event.conversation_id as string | undefined) ?? conversationId;
    if (event.event === 'result') {
      const r = event.result as { conversation_id?: string; status?: string; response?: string; error?: string } | undefined;
      conversationId = r?.conversation_id ?? conversationId;
      status = r?.status;
      response = r?.response;
      if (r?.error) error = r.error;
    }
  }
  const text = (response ?? '').trim();
  if (!out.ok) return { ok: false, text: '', error: error ?? out.error, resumeId: conversationId };
  if (status && status !== 'SUCCESS' && !text) return { ok: false, text: '', error: error ?? `Antigravity ended with ${status}`, resumeId: conversationId };
  return { ok: true, text, resumeId: conversationId };
}

/** Antigravity's tool names, as the summariser knows them. Anything else is named and nothing more. */
const ANTIGRAVITY_TOOLS: Record<string, string> = {
  view_file: 'Read',
  view_file_outline: 'Read',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  sed_file: 'Edit',
  write_to_file: 'Write',
  run_command: 'Bash',
  grep_search: 'Grep',
  find_by_name: 'Glob',
  list_dir: 'Glob',
  read_url_content: 'WebFetch',
  search_web: 'WebSearch',
  invoke_subagent: 'Task',
  browser_subagent: 'Task',
};

/**
 * One line of `agy --output-format stream-json`, as an activity line or nothing.
 *
 * Pure, so the stream shape can be unit-tested against captured lines. Verified
 * against agy 1.3.5: a tool step appears twice, `ACTIVE` then `DONE`; only the
 * first is reported. **`tool_info.output` is the tool's result and is never
 * read** (ADR 0015). Antigravity names its arguments in its own way
 * (`AbsolutePath`, `TargetFile`, `CommandLine`, `Query`, `Pattern`, `Url`), so
 * the one descriptor each summariser case reads is mapped here, and only that one.
 */
export function antigravityActivity(line: string): ActivityLine | null {
  if (!line.startsWith('{')) return null;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (event.event !== 'step_update') return null;
  const step = event.step_update as { step_type?: string; state?: string; tool_name?: string; tool_info?: { parameters?: Record<string, unknown> } } | undefined;
  if (step?.step_type !== 'tool' || step.state !== 'ACTIVE' || !step.tool_name) return null;
  const p = step.tool_info?.parameters ?? {};
  const name = ANTIGRAVITY_TOOLS[step.tool_name];
  // call_mcp_tool and anything unknown: the name only.
  if (!name) return summarise({ name: step.tool_name });
  const args =
    name === 'Bash'
      ? { command: p.CommandLine ?? p.Command ?? p.command }
      : name === 'Glob' || name === 'Grep'
        ? { pattern: p.Pattern ?? p.Query ?? p.SearchDirectory ?? p.DirectoryPath }
        : name === 'WebFetch'
          ? { url: p.Url ?? p.url }
          : name === 'WebSearch'
            ? { query: p.query ?? p.Query }
            : name === 'Task'
              ? {}
              : { file_path: p.AbsolutePath ?? p.TargetFile ?? p.FilePath ?? p.file_path };
  return summarise({ name, args });
}

function emitAntigravityActivity(line: string, req: SpawnRequest): void {
  const activity = antigravityActivity(line);
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
/** ADR 0054: the three variables anything Fabrikka runs may report with. */
function reportEnv(req: SpawnRequest): Record<string, string> {
  return req.report ? { FABRIKKA_REPORT_URL: req.report.url, FABRIKKA_RUN_TOKEN: req.report.token, FABRIKKA_RUN_ID: req.report.runId } : {};
}

/**
 * ADR 0054: any command as an agent. Started once per mention with the
 * preamble and the prompt on stdin; its stdout is the reply when it posted
 * nothing itself. Nothing confines it, so the policy is Full by construction.
 * It may report through the variables; the runner reports start and end.
 */
function runCommand(req: SpawnRequest): Promise<SpawnResult> {
  const argv = req.command ?? [];
  if (argv.length === 0) return Promise.resolve({ ok: false, text: '', error: 'no command given (fabrikka run -- <command…>)' });
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: req.cwd,
      env: { ...process.env, ...reportEnv(req) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ ok: false, text: stdout, error: `run exceeded ${RUN_TIMEOUT_MS / 60000} minutes and was stopped` });
    }, RUN_TIMEOUT_MS);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ ok: false, text: stdout, error: 'run was stopped' });
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => {
      stderr += String(d);
      for (const line of String(d).split('\n')) if (line.trim()) req.onLog?.(line);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, text: '', error: `could not start ${argv[0]}: ${err.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      resolve(code === 0 ? { ok: true, text: stdout.trim() } : { ok: false, text: stdout, error: `${argv[0]} exited with ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}` });
    });
    child.stdin.end(`${req.systemPreamble}\n\n${req.prompt}\n`);
  });
}

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
      // they are the user's, not ours. ADR 0054: plus where this run may report.
      env: { ...process.env, ...reportEnv(req), ...extraEnv },
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
 * `CODEX_BIN` / `CLAUDE_BIN` / `OPENCODE_BIN` win, so a user with an unusual install can say so.
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
