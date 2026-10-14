/**
 * Linear (M18, ADR 0024). Listed: the owner connected it for real on
 * 2026-10-14 ("verified, not documented").
 *
 * Probed 2026-10-10, without signing in:
 *   - POST https://mcp.linear.app/mcp → 401,
 *     `WWW-Authenticate: Bearer realm="OAuth", resource_metadata=
 *     "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
 *     scope="read write"`;
 *   - protected resource (RFC 9728): resource https://mcp.linear.app/mcp,
 *     authorization server https://mcp.linear.app, scopes read and write;
 *   - authorization server (RFC 8414): registration_endpoint
 *     https://mcp.linear.app/register (dynamic registration, so no operator
 *     setup), PKCE S256 only, token auth none / client_secret_post /
 *     client_secret_basic, scopes read, write, openid and email.
 *
 * Presets, from the owner's real connection (68 tools, 2026-10-14). Read is everything that
 * only looks. Write adds what creates or changes, and leaves out deleting,
 * merging, forking, and anything that hands work to another agent or spends
 * credits: those are granted by hand, tool by tool.
 * Out of both: delete_*, retire_* / restore_*, share_issue / unshare_issue
 * (public links), merge_diff, extract_images.
 */
import type { CatalogueEntry } from './types.ts';

export const linear: CatalogueEntry = {
  id: 'linear',
  name: 'Linear',
  category: 'issues',
  description: 'Issues, projects and cycles — find, create, comment and move issues.',
  slug: 'linear',
  mcpUrl: 'https://mcp.linear.app/mcp',
  auth: {
    type: 'oauth',
    // What its 401 and resource metadata ask for.
    scopes: ['read', 'write'],
  },
  presets: {
    read: [
      'get_attachment',
      'list_agent_skills',
      'get_agent_skill',
      'list_comments',
      'list_cycles',
      'list_custom_views',
      'get_document',
      'list_documents',
      'get_issue',
      'list_issues',
      'list_issue_statuses',
      'get_issue_status',
      'list_issue_labels',
      'list_projects',
      'get_project',
      'list_project_labels',
      'list_release_pipelines',
      'list_releases',
      'get_release',
      'list_release_notes',
      'get_release_note',
      'list_milestones',
      'get_milestone',
      'get_notifications',
      'list_teams',
      'get_team',
      'get_triage_responsibility',
      'list_templates',
      'get_template',
      'list_users',
      'get_user',
      'get_workspace',
      'search_documentation',
      'get_diff',
      'list_diffs',
      'get_diff_threads',
      'get_status_updates',
    ],
    write: [
      'prepare_attachment_upload',
      'create_attachment_from_upload',
      'create_attachment',
      'save_comment',
      'save_document',
      'save_issue',
      'save_issue_label',
      'create_issue_label',
      'save_project',
      'save_project_label',
      'save_release',
      'save_release_note',
      'save_milestone',
      'mark_notification',
      'save_diff_comment',
      'resolve_diff_thread',
      'submit_diff_review',
      'update_diff',
      'save_status_update',
    ],
  },
  keywords: ['tickets', 'issues', 'projects', 'cycles', 'sprints', 'bugs'],
  // Simple Icons 13.21.0 (CC0), "linear".
  logo: {
    color: '#5E6AD2',
    path: 'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z',
  },
};
