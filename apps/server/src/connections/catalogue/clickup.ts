/**
 * ClickUp (M18, ADR 0024). Listed: the owner connected it for real on
 * 2026-10-14 ("verified, not documented").
 *
 * Probed 2026-10-13, without signing in:
 *   - POST https://mcp.clickup.com/mcp → 401, `WWW-Authenticate: Bearer
 *     realm="MCP Server", error="invalid_token", resource_metadata=
 *     "https://mcp.clickup.com/.well-known/oauth-protected-resource/mcp"`;
 *   - protected resource (RFC 9728): resource https://mcp.clickup.com/mcp,
 *     "API for managing ClickUp tasks, documents, and chat via MCP",
 *     authorization server https://mcp.clickup.com, scopes read, write,
 *     resource indicators supported;
 *   - authorization server (RFC 8414): registration_endpoint
 *     https://mcp.clickup.com/oauth/register (dynamic registration, so no
 *     operator setup), PKCE S256, token auth none only, and ONE grant:
 *     authorization_code. No refresh_token grant.
 *
 * So Fabrikka registers a public client and asks for no refresh grant (the
 * registration request follows the server's metadata). An expired access token
 * can't be renewed: the connection shows *needs reconnecting* and Reconnect is
 * one click plus ClickUp's consent. Confirm the token lifetime on the first
 * real connection.
 *
 * Presets, from the owner's real connection (61 tools, 2026-10-14). Read is everything that
 * only looks. Write adds what creates or changes, and leaves out deleting,
 * merging, forking, and anything that hands work to another agent or spends
 * credits: those are granted by hand, tool by tool.
 * Out of both: clickup_delete_*, clickup_merge_tasks, clickup_execute_operator
 * (runs any operator clickup_get_operators lists).
 * Confirmed on connecting: the token ClickUp issued expires in ten years, so
 * the missing refresh grant costs nothing in practice.
 */
import type { CatalogueEntry } from './types.ts';

export const clickup: CatalogueEntry = {
  id: 'clickup',
  name: 'ClickUp',
  category: 'issues',
  description: 'Tasks, lists and docs — find, create, comment on and move tasks through their statuses.',
  slug: 'clickup',
  mcpUrl: 'https://mcp.clickup.com/mcp',
  auth: { type: 'oauth', scopes: ['read', 'write'] },
  presets: {
    read: [
      'clickup_download_task_attachment',
      'clickup_get_chat_channels',
      'clickup_get_chat_channel_messages',
      'clickup_get_chat_message_replies',
      'clickup_get_task_comments',
      'clickup_get_threaded_comments',
      'clickup_get_custom_fields',
      'clickup_list_document_pages',
      'clickup_get_document_pages',
      'clickup_list_document_page_attachments',
      'clickup_download_document_page_attachment',
      'clickup_get_folder',
      'clickup_get_list',
      'clickup_get_workspace_members',
      'clickup_find_member_by_name',
      'clickup_resolve_assignees',
      'clickup_search_reminders',
      'clickup_get_task',
      'clickup_filter_tasks',
      'clickup_get_current_time_entry',
      'clickup_get_time_entries',
      'clickup_get_task_time_in_status',
      'clickup_get_bulk_tasks_time_in_status',
      'clickup_get_operators',
      'clickup_get_schema',
      'clickup_search',
      'clickup_get_workspace_hierarchy',
    ],
    write: [
      'clickup_attach_task_file',
      'clickup_request_attachment_upload',
      'clickup_send_chat_message',
      'clickup_create_comment',
      'clickup_create_task_comment',
      'clickup_update_comment',
      'clickup_create_document',
      'clickup_create_document_page',
      'clickup_update_document_page',
      'clickup_create_folder',
      'clickup_update_folder',
      'clickup_create_list',
      'clickup_create_list_in_folder',
      'clickup_update_list',
      'clickup_create_reminder',
      'clickup_update_reminder',
      'clickup_add_tag_to_task',
      'clickup_remove_tag_from_task',
      'clickup_add_task_dependency',
      'clickup_remove_task_dependency',
      'clickup_add_task_link',
      'clickup_remove_task_link',
      'clickup_create_task',
      'clickup_update_task',
      'clickup_move_task',
      'clickup_add_task_to_list',
      'clickup_remove_task_from_list',
      'clickup_start_time_tracking',
      'clickup_stop_time_tracking',
      'clickup_add_time_entry',
    ],
  },
  keywords: ['tasks', 'tickets', 'lists', 'sprints', 'spaces', 'docs', 'project management'],
  // Simple Icons 13.21.0 (CC0), "clickup".
  logo: {
    color: '#7B68EE',
    path: 'M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z',
  },
};
