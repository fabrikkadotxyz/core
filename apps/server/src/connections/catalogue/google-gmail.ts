/**
 * Gmail (M18, ADR 0024, ADR 0046). Listed on the owner's decision
 * (2026-10-15), ahead of a real connection; the first one fills in its presets.
 *
 * Probed 2026-10-15, without signing in:
 *   - POST https://gmailmcp.googleapis.com/mcp/v1 answers 200 with no challenge
 *     (initialize and tools/list alike), so discovery derives the resource
 *     metadata from the path: /.well-known/oauth-protected-resource/mcp/v1 →
 *     authorization server https://accounts.google.com/ (RFC 8414 metadata at
 *     the standard URL), PKCE S256, client_secret_post, refresh grant;
 *   - no dynamic registration: one Google Cloud OAuth client per instance
 *     (docs/operations.md, "Google"), marked for an AI-powered agent;
 *   - a refresh token only with access_type=offline and prompt=consent.
 *
 * Its scopes are Google's *restricted* tier: they go on the consent screen in a second round, behind the four others (ADR 0046).
 * Presets come from the owner's real connection, once it exists.
 */
import type { CatalogueEntry } from './types.ts';

export const googleGmail: CatalogueEntry = {
  id: 'google-gmail',
  name: 'Gmail',
  category: 'email',
  description: 'Mail — search and read threads, draft and send replies.',
  slug: 'gmail',
  mcpUrl: 'https://gmailmcp.googleapis.com/mcp/v1',
  auth: {
    type: 'oauth',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
    client: { idEnv: 'GOOGLE_OAUTH_CLIENT_ID', secretEnv: 'GOOGLE_OAUTH_CLIENT_SECRET' },
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
  },
  keywords: ['mail', 'email', 'inbox', 'threads', 'google'],
  // Simple Icons 16.35.0 (CC0), "gmail".
  logo: {
    color: '#EA4335',
    path: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
  },
};
