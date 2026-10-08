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
};
