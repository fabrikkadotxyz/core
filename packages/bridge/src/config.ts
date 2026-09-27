/**
 * Bridge configuration.
 *
 * Supplied through the environment because that is what `.mcp.json` can set for
 * a stdio server, and because a token on a command line shows up in `ps`.
 */
export interface BridgeConfig {
  /** The session's MCP endpoint, e.g. https://host/mcp/o/fede/s/demo */
  mcpUrl: string;
  /** Derived from mcpUrl: ws(s)://host/bridge/o/fede/s/demo */
  bridgeUrl: string;
  token: string;
}

export function loadConfig(argv: string[]): BridgeConfig {
  const mcpUrl = flag(argv, 'url') ?? process.env.FABRIKKA_URL;
  const token = flag(argv, 'token') ?? process.env.FABRIKKA_TOKEN;

  if (!mcpUrl || !token) {
    throw new Error(
      'FABRIKKA_URL and FABRIKKA_TOKEN are required.\n' +
        'Copy the .mcp.json block from your session\'s Agents panel.',
    );
  }

  return { mcpUrl, token, bridgeUrl: toBridgeUrl(mcpUrl) };
}

/**
 * `/mcp/o/{owner}/s/{session}` -> `ws(s)://…/bridge/o/{owner}/s/{session}`.
 *
 * Derived rather than configured separately so the two can never point at
 * different sessions.
 */
export function toBridgeUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  const match = url.pathname.match(/\/mcp\/o\/([^/]+)\/s\/([^/]+)\/?$/);
  if (!match) {
    throw new Error(
      `FABRIKKA_URL does not look like a session endpoint: ${mcpUrl}\n` +
        'Expected .../mcp/o/{owner}/s/{session}',
    );
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `/bridge/o/${match[1]}/s/${match[2]}`;
  return url.toString();
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  return value && !value.startsWith('--') ? value : undefined;
}
