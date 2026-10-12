/**
 * Sentry (M18, ADR 0024). PREPARED, NOT LISTED: it isn't in registry.ts until
 * the owner has connected it for real ("verified, not documented").
 *
 * Probed 2026-10-12, without signing in:
 *   - POST https://mcp.sentry.dev/mcp → 401, `WWW-Authenticate: Bearer
 *     realm="OAuth", resource_metadata=
 *     "https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp"` (no scope);
 *   - protected resource (RFC 9728): resource https://mcp.sentry.dev/mcp,
 *     authorization server https://mcp.sentry.dev, scopes org:read,
 *     project:write, team:write, event:write, alerts:write;
 *   - authorization server (RFC 8414): registration_endpoint
 *     https://mcp.sentry.dev/oauth/register (dynamic registration, so no
 *     operator setup), PKCE S256, token auth none / client_secret_basic /
 *     client_secret_post.
 *
 * No scope is asked for: the 401 names none, and Sentry's consent page lets the
 * person choose. Confirm on the first real connection. Presets are filled in
 * from a real connection's tool list, not from docs.
 */
import type { CatalogueEntry } from './types.ts';

export const sentry: CatalogueEntry = {
  id: 'sentry',
  name: 'Sentry',
  category: 'observability',
  description: 'Errors and issues — find an issue, read its events and stack traces, resolve it.',
  slug: 'sentry',
  mcpUrl: 'https://mcp.sentry.dev/mcp',
  auth: { type: 'oauth' },
  keywords: ['errors', 'exceptions', 'crashes', 'stack traces', 'monitoring', 'incidents'],
  // Simple Icons 13.21.0 (CC0), "sentry".
  logo: {
    color: '#362D59',
    path: 'M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z',
  },
};
