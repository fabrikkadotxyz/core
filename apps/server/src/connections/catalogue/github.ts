/**
 * GitHub (M18, ADR 0024). Probed 2026-10-07: its MCP server's 401 points to
 * github.com/login/oauth — PKCE, no dynamic registration — so the instance needs
 * a GitHub OAuth App (docs/operations.md), and GitHub is absent until it has one.
 *
 * Presets are filled in from a real connection's tool list, not from docs.
 */
import type { CatalogueEntry } from './types.ts';

export const github: CatalogueEntry = {
  id: 'github',
  name: 'GitHub',
  category: 'code',
  description: 'Repositories, issues and pull requests — read code, open and review PRs.',
  slug: 'github',
  mcpUrl: 'https://api.githubcopilot.com/mcp/',
  auth: {
    type: 'oauth',
    // From its resource metadata: what reading and changing repos and PRs needs.
    scopes: ['repo', 'read:org', 'read:user'],
    client: { idEnv: 'GITHUB_OAUTH_CLIENT_ID', secretEnv: 'GITHUB_OAUTH_CLIENT_SECRET' },
  },
};
