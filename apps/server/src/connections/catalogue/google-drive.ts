/**
 * Google Drive (M18, ADR 0024, ADR 0046). Listed on the owner's decision
 * (2026-10-15), ahead of a real connection; the first one fills in its presets.
 *
 * Probed 2026-10-15, without signing in:
 *   - POST https://drivemcp.googleapis.com/mcp/v1 answers 200 with no challenge
 *     (initialize and tools/list alike), so discovery derives the resource
 *     metadata from the path: /.well-known/oauth-protected-resource/mcp/v1 →
 *     authorization server https://accounts.google.com/ (RFC 8414 metadata at
 *     the standard URL), PKCE S256, client_secret_post, refresh grant;
 *   - no dynamic registration: one Google Cloud OAuth client per instance
 *     (docs/operations.md, "Google"), marked for an AI-powered agent;
 *   - a refresh token only with access_type=offline and prompt=consent.
 *
 * drive.file reaches only files the app created or the person opened with it; drive.readonly reads the rest.
 * Presets come from the owner's real connection, once it exists.
 */
import type { CatalogueEntry } from './types.ts';

export const googleDrive: CatalogueEntry = {
  id: 'google-drive',
  name: 'Google Drive',
  category: 'docs',
  description: 'Files and folders — search and read files, create or update what the agent made.',
  slug: 'google-drive',
  mcpUrl: 'https://drivemcp.googleapis.com/mcp/v1',
  auth: {
    type: 'oauth',
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
    client: { idEnv: 'GOOGLE_OAUTH_CLIENT_ID', secretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET' },
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
  },
  keywords: ['files', 'folders', 'drive', 'storage', 'google'],
  // Simple Icons 16.35.0 (CC0), "googledrive".
  logo: {
    color: '#4285F4',
    path: 'M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z',
  },
};
