/**
 * Google Docs (M18, ADR 0024, ADR 0046). PREPARED, NOT LISTED: it isn't in registry.ts
 * until the owner has connected it for real ("verified, not documented").
 *
 * Probed 2026-10-15, without signing in:
 *   - POST https://docsmcp.googleapis.com/mcp/v1 answers 200 with no challenge
 *     (initialize and tools/list alike), so discovery derives the resource
 *     metadata from the path: /.well-known/oauth-protected-resource/mcp/v1 →
 *     authorization server https://accounts.google.com/ (RFC 8414 metadata at
 *     the standard URL), PKCE S256, client_secret_post, refresh grant;
 *   - no dynamic registration: one Google Cloud OAuth client per instance
 *     (docs/operations.md, "Google"), marked for an AI-powered agent;
 *   - a refresh token only with access_type=offline and prompt=consent.
 *
 * A connection to Google's own Docs server; the `gdoc` output kind (M14) is a different thing.
 * Presets come from the owner's real connection, once it exists.
 */
import type { CatalogueEntry } from './types.ts';

export const googleDocs: CatalogueEntry = {
  id: 'google-docs',
  name: 'Google Docs',
  category: 'docs',
  description: 'Documents — read a doc, write or update one.',
  slug: 'google-docs',
  mcpUrl: 'https://docsmcp.googleapis.com/mcp/v1',
  auth: {
    type: 'oauth',
    scopes: [
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
    client: { idEnv: 'GOOGLE_OAUTH_CLIENT_ID', secretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET' },
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
  },
  keywords: ['documents', 'docs', 'writing', 'google'],
  // Simple Icons 16.35.0 (CC0), "googledocs".
  logo: {
    color: '#4285F4',
    path: 'M14.727 6.727H14V0H4.91c-.905 0-1.637.732-1.637 1.636v20.728c0 .904.732 1.636 1.636 1.636h14.182c.904 0 1.636-.732 1.636-1.636V6.727h-6zm-.545 10.455H7.09v-1.364h7.09v1.364zm2.727-3.273H7.091v-1.364h9.818v1.364zm0-3.273H7.091V9.273h9.818v1.363zM14.727 6h6l-6-6v6z',
  },
};
