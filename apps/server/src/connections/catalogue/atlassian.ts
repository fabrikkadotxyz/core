/**
 * Jira and Confluence (M18, ADR 0024): two entries, one Atlassian connection.
 *
 * Probed 2026-10-08: https://mcp.atlassian.com/v2/mcp answers 401 with RFC 9728
 * metadata naming auth.atlassian.com/<tenant> — dynamic registration, PKCE (S256),
 * public clients — so nothing is configured on the instance. One connection, one
 * slug ("atlassian"): connecting either entry connects both.
 *
 * Scopes: read, search and write for Jira and Confluence, offline_access for
 * refresh tokens. Not delete or manage — least privilege; widen with evidence.
 * Presets come from a real connection's tool list, not from docs.
 */
import type { CatalogueEntry } from './types.ts';

const MCP_URL = 'https://mcp.atlassian.com/v2/mcp';
const SCOPES = [
  'offline_access',
  'read:me',
  'read:account',
  'read:jira:agent-interface',
  'search:jira:agent-interface',
  'write:jira:agent-interface',
  'read:confluence:agent-interface',
  'search:confluence:agent-interface',
  'write:confluence:agent-interface',
];

export const jira: CatalogueEntry = {
  id: 'jira',
  name: 'Jira',
  category: 'issues',
  description: 'Issues and epics — find, create, comment and move tickets through their workflow.',
  slug: 'atlassian',
  connectionName: 'Atlassian',
  mcpUrl: MCP_URL,
  auth: { type: 'oauth', scopes: SCOPES },
  keywords: ['atlassian', 'tickets', 'issues', 'epics', 'sprints', 'bugs'],
  // Simple Icons 13.21.0 (CC0), "jira".
  logo: {
    color: '#0052CC',
    path: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z',
  },
};

export const confluence: CatalogueEntry = {
  id: 'confluence',
  name: 'Confluence',
  category: 'docs',
  description: 'Pages and spaces — search, read and update documentation.',
  slug: 'atlassian',
  connectionName: 'Atlassian',
  mcpUrl: MCP_URL,
  auth: { type: 'oauth', scopes: SCOPES },
  keywords: ['atlassian', 'wiki', 'pages', 'spaces', 'documentation'],
  // Simple Icons 13.21.0 (CC0), "confluence".
  logo: {
    color: '#172B4D',
    path: 'M.87 18.257c-.248.382-.53.875-.763 1.245a.764.764 0 0 0 .255 1.04l4.965 3.054a.764.764 0 0 0 1.058-.26c.199-.332.454-.763.733-1.221 1.967-3.247 3.945-2.853 7.508-1.146l4.957 2.337a.764.764 0 0 0 1.028-.382l2.364-5.346a.764.764 0 0 0-.382-1 599.851 599.851 0 0 1-4.965-2.361C10.911 10.97 5.224 11.185.87 18.257zM23.131 5.743c.249-.405.531-.875.764-1.25a.764.764 0 0 0-.256-1.034L18.675.404a.764.764 0 0 0-1.058.26c-.195.335-.451.763-.734 1.225-1.966 3.246-3.945 2.85-7.508 1.146L4.437.694a.764.764 0 0 0-1.027.382L1.046 6.422a.764.764 0 0 0 .382 1c1.039.49 3.105 1.467 4.965 2.361 6.698 3.246 12.392 3.029 16.738-4.04z',
  },
};
