/**
 * A stand-in for GitHub/Sentry: a real streamable-HTTP MCP server that requires a
 * bearer token and reports which one it saw.
 *
 * Reporting the caller's token back is what lets the acceptance test prove the
 * property that matters — that Alice's call goes upstream with ALICE's
 * credential, not the session owner's (ADR 0004). A mock that ignored auth could
 * not distinguish a correct implementation from a confused deputy.
 */
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import { serve } from '@hono/node-server';
import { z } from 'zod';

const PORT = Number(process.argv[2] ?? 9191);

const app = createMcpHonoApp();

const handler = createMcpHandler((ctx) => {
  const token = ctx.authInfo?.token ?? 'anonymous';
  const server = new McpServer({ name: 'fake-github', version: '0.0.1' });

  server.registerTool(
    'whoami',
    { description: 'Report which credential reached this server.', inputSchema: z.object({}) },
    async () => ({ content: [{ type: 'text', text: JSON.stringify({ seen_token: token }) }] }),
  );

  server.registerTool(
    'list_issues',
    {
      description: 'List issues (read).',
      inputSchema: z.object({ repo: z.string().optional() }),
    },
    async (args) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ repo: args.repo ?? 'default', issues: ['#1', '#2'], seen_token: token }),
        },
      ],
    }),
  );

  server.registerTool(
    'merge_pull_request',
    {
      description: 'Merge a PR (write). The one a session should be able to deny.',
      inputSchema: z.object({ number: z.number() }),
    },
    async (args) => ({
      content: [{ type: 'text', text: JSON.stringify({ merged: args.number, seen_token: token }) }],
    }),
  );

  return server;
});

app.all('/mcp', async (c) => {
  const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return c.json({ error: 'unauthorized' }, 401);

  return handler.fetch(c.req.raw, {
    authInfo: { token: bearer, clientId: bearer, scopes: [] },
    parsedBody: c.get('parsedBody'),
  });
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.error(`upstream fixture on :${PORT}`);
});
