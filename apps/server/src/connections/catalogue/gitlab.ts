/**
 * GitLab (M18, ADR 0024). Listed: the owner connected it for real on
 * 2026-10-14 ("verified, not documented"). This entry
 * is gitlab.com; a self-managed GitLab has its own issuer and stays a custom
 * connection, like self-hosted Grafana.
 *
 * Probed 2026-10-13, without signing in:
 *   - POST https://gitlab.com/api/v4/mcp → 401, `WWW-Authenticate: Bearer
 *     realm="GitLab", scope="mcp", resource_metadata=
 *     "https://gitlab.com/.well-known/oauth-protected-resource/api/v4/mcp"`;
 *   - protected resource (RFC 9728): resource https://gitlab.com/api/v4/mcp,
 *     authorization server https://gitlab.com, scopes mcp;
 *   - authorization server (RFC 8414, also at the path-inserted URL
 *     /.well-known/oauth-authorization-server/api/v4/mcp): registration_endpoint
 *     https://gitlab.com/oauth/register (dynamic registration, so no operator
 *     setup), PKCE plain and S256, grants authorization_code, refresh_token,
 *     device_code and client_credentials, token auth client_secret_basic /
 *     client_secret_post — NOT none.
 *
 * So the registered client is confidential: Fabrikka asks for
 * client_secret_post, keeps the secret GitLab returns sealed, and sends it with
 * every token request (the registration request follows the server's metadata).
 * Confirm on the first real connection.
 *
 * Presets, from the owner's real connection (36 tools, 2026-10-14). Read is everything that
 * only looks. Write adds what creates or changes, and leaves out deleting,
 * merging, forking, and anything that hands work to another agent or spends
 * credits: those are granted by hand, tool by tool.
 * Out of both: accept_merge_request, fork_repository.
 * Confirmed on connecting: the confidential-client registration works.
 */
import type { CatalogueEntry } from './types.ts';

export const gitlab: CatalogueEntry = {
  id: 'gitlab',
  name: 'GitLab',
  category: 'code',
  description: 'Projects, issues, merge requests and pipelines — read code, open and review MRs.',
  slug: 'gitlab',
  mcpUrl: 'https://gitlab.com/api/v4/mcp',
  auth: { type: 'oauth', scopes: ['mcp'] },
  presets: {
    read: [
      'get_artifact_file',
      'get_job',
      'get_mcp_server_version',
      'list_releases',
      'list_tags',
      'get_commit',
      'get_merge_request',
      'get_repository_file',
      'get_pipeline',
      'get_project',
      'get_saved_view_work_items',
      'get_user',
      'get_work_item',
      'get_work_item_types',
      'list_commits',
      'list_groups',
      'list_merge_requests',
      'list_projects',
      'list_repository_tree',
      'list_project_members',
      'list_work_items',
      'search_labels',
      'list_pipelines',
      'list_branches',
      'semantic_search',
      'search',
    ],
    write: [
      'add_branch',
      'add_commit',
      'link_work_items',
      'save_merge_request',
      'save_merge_request_review',
      'save_note',
      'save_pipeline',
      'save_work_item',
    ],
  },
  keywords: ['git', 'repos', 'repositories', 'merge requests', 'mrs', 'pipelines', 'ci', 'code review'],
  // Simple Icons 13.21.0 (CC0), "gitlab".
  logo: {
    color: '#FC6D26',
    path: 'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z',
  },
};
