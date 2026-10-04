#!/usr/bin/env node
/**
 * fabrikka — the local bridge.
 *
 * Claude Code spawns THIS, not the reverse. It reads `.mcp.json`, starts this
 * process as a subprocess, and talks to it over stdin/stdout. The bridge never
 * starts, installs, configures or supervises an agent runtime — that is the rule
 * in ARCHITECTURE.md, and this file is where it would be tempting to break it.
 *
 *     Claude Code ──stdio──> fabrikka bridge ──WebSocket──> Fabrikka
 *
 * Usage (normally via .mcp.json, see the session's Agents panel):
 *     FABRIKKA_URL=… FABRIKKA_TOKEN=… fabrikka connect
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.ts';
import { watch } from './watch.ts';
import { runHost } from './host/host.ts';
import { randomUUID } from 'node:crypto';
import { createChannelServer, formatMention, pushToChannel } from './channel.ts';
import { summarise } from './redact.ts';
import { BridgeSocket } from './socket.ts';
import { Upstream } from './upstream.ts';

const VERSION = '0.0.0';

/**
 * stdout is the MCP transport — anything written there corrupts the protocol.
 * All diagnostics go to stderr, which Claude Code captures in its debug log.
 */
const log = (...args: unknown[]) => console.error('[fabrikka]', ...args);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'connect';

  if (command === 'help' || command === '--help') {
    console.error(
      'fabrikka connect\n' +
        '    Bridge a Fabrikka session into THIS agent session. Claude Code\n' +
        '    spawns this from .mcp.json; mentions arrive as channel events.\n' +
        '\n' +
        'fabrikka host [--server <url>]\n' +
        '    Run your agents on this computer, in folders you grant here.\n' +
        '    Pairs with your account once (no token to paste). Recommended.\n' +
        '\n' +
        'fabrikka watch --dir <project> [--provider claude-code|codex] [--policy read|edit|full]\n' +
        '    Spawn a headless run for each mention, in <project>. Policy\n' +
        '    defaults to edit: files in <project> only, no shell, no web.\n' +
        '\n' +
        'Both need FABRIKKA_URL and FABRIKKA_TOKEN. Copy the block from your\n' +
        "session's Agents panel.",
    );
    return;
  }
  if (command === 'host') {
    // M31 (ADR 0027): pair once, grant folders here, and your agents run in them.
    await runHost(argv.slice(1), (...a) => console.error('[fabrikka host]', ...a));
    return;
  }
  if (command !== 'connect' && command !== 'watch') {
    log(`unknown command: ${command}. Try: fabrikka help`);
    process.exitCode = 1;
    return;
  }

  const config = loadConfig(argv);

  if (command === 'watch') {
    const dir = flag(argv, 'dir') ?? process.cwd();
    const provider = flag(argv, 'provider') ?? 'claude-code';
    const allowedTools = flag(argv, 'allowed-tools')?.split(',').filter(Boolean);
    const policy = (flag(argv, 'policy') ?? 'edit') as 'read' | 'edit' | 'full';
    if (!['read', 'edit', 'full'].includes(policy)) {
      log('--policy is read, edit or full (ADR 0027)');
      process.exitCode = 1;
      return;
    }
    await watch({ config, dir, provider, policy, allowedTools, log });
    return;
  }
  const mcp = createChannelServer(VERSION);
  const upstream = new Upstream(config.mcpUrl, config.token);

  /* ---------------------------------------------------- proxied tools ---- */

  let tools: Awaited<ReturnType<Upstream['listTools']>> = [];

  try {
    await upstream.connect();
    tools = await upstream.listTools();
    log(`proxying ${tools.length} tools from ${config.mcpUrl}`);
  } catch (err) {
    // Start anyway. Failing to start would leave Claude Code reporting a dead
    // MCP server with no explanation; this way the channel still works and the
    // reason is in the debug log.
    log(`could not reach the session endpoint: ${(err as Error).message}`);
    log('starting with the channel only — tools will be unavailable');
  }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object' },
    })),
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    /**
     * A live session's activity is necessarily partial: Claude Code runs Read,
     * Bash and the rest in the user's own terminal, and the bridge is not in that
     * loop. What we CAN see is the tools the agent calls through us, which is
     * still worth showing — "read the session", "posted a reply". See ADR 0015.
     */
    if (channelRunId) {
      const { tool, detail } = summarise({ name: req.params.name, args });
      socket?.send({ type: 'activity', runId: channelRunId, tool, detail });
    }

    // Forwarded verbatim: the bridge holds no tool logic of its own (ADR 0010).
    const result = await upstream.callTool(req.params.name, args);

    // Posting is the only completion signal a channel turn gives us.
    if (channelRunId && req.params.name === 'post_message') {
      socket?.send({ type: 'run.end', runId: channelRunId, status: 'done' });
      channelRunId = undefined;
    }

    return result as never;
  });

  await mcp.connect(new StdioServerTransport());

  /* ------------------------------------------------------- the channel --- */

  /**
   * A channel run has no clean end signal — Claude Code does not tell us when the
   * turn finished. So one run is opened per pushed mention and closed when the
   * agent posts back, which is the only observable completion we get.
   */
  let channelRunId: string | undefined;

  const socket: BridgeSocket = new BridgeSocket(config.bridgeUrl, config.token, {
    onReady: (frame) => {
      log(
        `connected as @${frame.participant.display_name} in session ${frame.session.id}`,
      );
    },

    onMention: (frame) => {
      channelRunId = randomUUID();
      socket.send({
        type: 'run.start',
        runId: channelRunId,
        kind: 'channel',
        provider: 'claude-code',
        messageId: frame.message.id,
      });

      // meta keys MUST be [A-Za-z0-9_]+ or Claude Code drops them silently.
      // pushToChannel enforces that rather than trusting this call site.
      void pushToChannel(mcp, {
        content: formatMention(frame.message, frame.trust),
        meta: {
          author: frame.message.author.displayName,
          trust: frame.trust,
          message_id: frame.message.id,
        },
      })
        .then(() => {
          // Best-effort presence. The notification is not acknowledged, so this
          // says "handed to the model", not "the model has replied".
          socket.send({ type: 'status', status: 'working' });
        })
        .catch((err) => log(`failed to push mention: ${(err as Error).message}`));
    },

    onRefused: (code) => {
      log(
        code === 'unauthenticated'
          ? 'the session token was rejected — check FABRIKKA_TOKEN'
          : 'that session is not reachable with this token',
      );
    },

    onDisconnected: () => log('disconnected from Fabrikka, retrying…'),
  });

  socket.connect();

  const shutdown = () => {
    socket.close();
    void upstream.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log((err as Error).message);
  process.exit(1);
});

/** Shared with config.ts's parser; kept local to avoid exporting a helper. */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  return value && !value.startsWith('--') ? value : undefined;
}
