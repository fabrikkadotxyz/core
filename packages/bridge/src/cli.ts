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
import { createChannelServer, formatMention, pushToChannel } from './channel.ts';
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
        'fabrikka watch --dir <project> [--provider claude-code|codex]\n' +
        '    Spawn a headless run for each mention, in <project>. Runs start\n' +
        '    WITHOUT permission prompts — see the banner it prints.\n' +
        '\n' +
        'Both need FABRIKKA_URL and FABRIKKA_TOKEN. Copy the block from your\n' +
        "session's Agents panel.",
    );
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
    await watch({ config, dir, provider, allowedTools, log });
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
    // Forwarded verbatim: the bridge holds no tool logic of its own (ADR 0010).
    return (await upstream.callTool(req.params.name, args)) as never;
  });

  await mcp.connect(new StdioServerTransport());

  /* ------------------------------------------------------- the channel --- */

  const socket = new BridgeSocket(config.bridgeUrl, config.token, {
    onReady: (frame) => {
      log(
        `connected as @${frame.participant.display_name} in session ${frame.session.id}`,
      );
    },

    onMention: (frame) => {
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
