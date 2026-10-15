/**
 * Google Sheets (M18, ADR 0024, ADR 0046). Listed on the owner's decision
 * (2026-10-15), ahead of a real connection; the first one fills in its presets.
 *
 * Probed 2026-10-15, without signing in:
 *   - POST https://sheetsmcp.googleapis.com/mcp/v1 answers 200 with no challenge
 *     (initialize and tools/list alike), so discovery derives the resource
 *     metadata from the path: /.well-known/oauth-protected-resource/mcp/v1 →
 *     authorization server https://accounts.google.com/ (RFC 8414 metadata at
 *     the standard URL), PKCE S256, client_secret_post, refresh grant;
 *   - no dynamic registration: one Google Cloud OAuth client per instance
 *     (docs/operations.md, "Google"), marked for an AI-powered agent;
 *   - a refresh token only with access_type=offline and prompt=consent.
 *
 * Google's guide lists Drive's scopes beside spreadsheets; asked together so one consent covers finding and opening a sheet.
 * Presets come from the owner's real connection, once it exists.
 */
import type { CatalogueEntry } from './types.ts';

export const googleSheets: CatalogueEntry = {
  id: 'google-sheets',
  name: 'Google Sheets',
  category: 'docs',
  description: 'Spreadsheets — read ranges, write cells, create sheets.',
  slug: 'google-sheets',
  mcpUrl: 'https://sheetsmcp.googleapis.com/mcp/v1',
  auth: {
    type: 'oauth',
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
    client: { idEnv: 'GOOGLE_OAUTH_CLIENT_ID', secretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET' },
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
  },
  keywords: ['spreadsheets', 'sheets', 'tables', 'cells', 'google'],
  // Simple Icons 16.35.0 (CC0), "googlesheets".
  logo: {
    color: '#34A853',
    path: 'M11.318 12.545H7.91v-1.909h3.41v1.91zM14.728 0v6h6l-6-6zm1.363 10.636h-3.41v1.91h3.41v-1.91zm0 3.273h-3.41v1.91h3.41v-1.91zM20.727 6.5v15.864c0 .904-.732 1.636-1.636 1.636H4.909a1.636 1.636 0 0 1-1.636-1.636V1.636C3.273.732 4.005 0 4.909 0h9.318v6.5h6.5zm-3.273 2.773H6.545v7.909h10.91v-7.91zm-6.136 4.636H7.91v1.91h3.41v-1.91z',
  },
};
