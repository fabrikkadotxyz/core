/**
 * API client.
 *
 * Requests go to a relative /api path: Vite proxies it in dev and it is
 * same-origin in production, so cookie-based auth behaves identically in both.
 */
import type {
  AgentSummary,
  Artifact,
  AgentTrustPolicy,
  AuthUser,
  CreatedAgentView,
  CreatedInviteView,
  InviteSummary,
  LoginBody,
  Member,
  Message,
  Output,
  OutputEdit,
  OutputEditSummary,
  OutputKindInfo,
  Participant,
  SessionLink,
  PauseState,
  ServerEvent,
  SessionContext,
  SessionSummary,
  SessionView,
  SignupBody,
} from '@fabrikka/types';

/** Mirrors the server's token listing; kept here so the UI has a name for it. */
export interface TokenSummary {
  id: string;
  participantId: string;
  participantName: string;
  label: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });

  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : undefined;

  if (!res.ok) {
    const message =
      (json as { error?: string } | undefined)?.error ?? `request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return json as T;
}

/* ------------------------------------------------------------------- auth */

export const auth = {
  me: () => call<{ user: AuthUser }>('/auth/me'),
  login: (body: LoginBody) =>
    call<{ user: AuthUser }>('/auth/login', { method: 'POST', body }),
  logout: () => call<{ ok: true }>('/auth/logout', { method: 'POST' }),
  signup: (body: SignupBody) =>
    call<{ user: AuthUser; session: { ownerSlug: string; publicId: string } }>(
      '/auth/signup',
      { method: 'POST', body },
    ),
};

/* --------------------------------------------------------------- invites */

export const invites = {
  /** Unauthenticated preview, so the invite page can name the session. */
  preview: (token: string) =>
    call<{ sessionTitle: string; invitedEmail: string | null }>(`/invites/${token}`),
  redeem: (token: string) =>
    call<{ session: { ownerSlug: string; publicId: string } }>(
      `/invites/${token}/redeem`,
      { method: 'POST' },
    ),
};

/* -------------------------------------------------------------- sessions */

export interface SessionRef {
  owner: string;
  session: string;
}

const base = ({ owner, session }: SessionRef) =>
  `/o/${encodeURIComponent(owner)}/s/${encodeURIComponent(session)}`;

export const sessions = {
  list: () => call<SessionSummary[]>('/sessions'),
  create: (title: string) =>
    call<SessionSummary>('/sessions', { method: 'POST', body: { title } }),
  get: (ref: SessionRef) => call<SessionView>(base(ref)),
  update: (ref: SessionRef, body: { title?: string; status?: 'active' | 'archived' }) =>
    call<{ ok: true }>(base(ref), { method: 'PATCH', body }),
  remove: (ref: SessionRef) => call<{ ok: true }>(base(ref), { method: 'DELETE' }),

  messages: (ref: SessionRef) => call<Message[]>(`${base(ref)}/messages`),
  postMessage: (ref: SessionRef, content: string, mentions: string[] = []) =>
    call<Message>(`${base(ref)}/messages`, {
      method: 'POST',
      body: { content, mentions },
    }),

  participants: (ref: SessionRef) => call<Participant[]>(`${base(ref)}/participants`),
  renameParticipant: (ref: SessionRef, participantId: string, displayName: string) =>
    call<Participant>(`${base(ref)}/participants/${participantId}`, {
      method: 'PATCH',
      body: { displayName },
    }),

  members: (ref: SessionRef) => call<Member[]>(`${base(ref)}/members`),
  removeMember: (ref: SessionRef, userId: string) =>
    call<{ ok: true }>(`${base(ref)}/members/${userId}`, { method: 'DELETE' }),

  agents: (ref: SessionRef) => call<AgentSummary[]>(`${base(ref)}/agents`),
  addAgent: (ref: SessionRef, body: { displayName: string; provider?: string }) =>
    call<CreatedAgentView>(`${base(ref)}/agents`, { method: 'POST', body }),
  setAgentTrust: (ref: SessionRef, sessionAgentId: string, trustTier: AgentTrustPolicy) =>
    call<{ ok: true }>(`${base(ref)}/agents/${sessionAgentId}/trust`, {
      method: 'PATCH',
      body: { trustTier },
    }),
  setAgentActivity: (ref: SessionRef, sessionAgentId: string, visible: boolean) =>
    call<{ ok: true }>(`${base(ref)}/agents/${sessionAgentId}/activity`, {
      method: 'PATCH',
      body: { visible },
    }),

  tokens: (ref: SessionRef) => call<TokenSummary[]>(`${base(ref)}/tokens`),
  revokeToken: (ref: SessionRef, id: string) =>
    call<{ ok: true }>(`${base(ref)}/tokens/${id}/revoke`, { method: 'POST' }),

  pauseState: (ref: SessionRef) => call<PauseState>(`${base(ref)}/pause`),
  pauseAgents: (ref: SessionRef) =>
    call<PauseState & { connectionsAskedToAbort: number }>(`${base(ref)}/pause`, {
      method: 'POST',
    }),
  resumeAgents: (ref: SessionRef) =>
    call<PauseState>(`${base(ref)}/pause`, { method: 'DELETE' }),

  context: (ref: SessionRef) => call<SessionContext>(`${base(ref)}/context`),
  /**
   * Append-first. `add`/`remove` never need a version; replacing a whole list
   * requires the one you read, so a stale write is rejected rather than winning
   * silently (ADR 0013).
   */
  updateContext: (
    ref: SessionRef,
    update: {
      objective?: string;
      add?: Record<string, string[]>;
      remove?: Record<string, string[]>;
      replace?: Record<string, string[]>;
      ifVersion?: number;
    },
  ) => call<SessionContext>(`${base(ref)}/context`, { method: 'PATCH', body: update }),

  integrations: (ref: SessionRef) =>
    call<{
      mine: { id: string; slug: string; label: string; url: string; hasCredential: boolean }[];
      inSession: { slug: string; label: string; attachedBy: number }[];
      grants: { serverSlug: string; toolName: string; allowed: boolean }[];
      encryptionConfigured: boolean;
    }>(`${base(ref)}/integrations`),
  attachIntegration: (
    ref: SessionRef,
    body: { slug: string; label?: string; url: string; credential?: string },
  ) => call<unknown>(`${base(ref)}/integrations`, { method: 'POST', body }),
  detachIntegration: (ref: SessionRef, slug: string) =>
    call<{ ok: true }>(`${base(ref)}/integrations/${slug}`, { method: 'DELETE' }),
  integrationTools: (ref: SessionRef, slug: string) =>
    call<{ name: string; description?: string }[]>(
      `${base(ref)}/integrations/${slug}/tools`,
    ),
  setToolGrant: (ref: SessionRef, slug: string, tool: string, allowed: boolean) =>
    call<{ ok: true }>(`${base(ref)}/integrations/${slug}/tools/${tool}`, {
      method: 'PUT',
      body: { allowed },
    }),

  artifacts: (ref: SessionRef) => call<Artifact[]>(`${base(ref)}/artifacts`),
  /** M19: pointers to tickets, PRs, repos, docs. Saving an existing URL updates it. */
  links: (ref: SessionRef) => call<SessionLink[]>(`${base(ref)}/links`),
  saveLink: (ref: SessionRef, link: { url: string; type: string; title?: string; status?: string }) =>
    call<SessionLink>(`${base(ref)}/links`, { method: 'PUT', body: link }),
  removeLink: (ref: SessionRef, url: string) =>
    call<{ ok: true }>(`${base(ref)}/links?url=${encodeURIComponent(url)}`, { method: 'DELETE' }),
  addLink: (ref: SessionRef, name: string, url: string) =>
    call<Artifact>(`${base(ref)}/artifacts`, { method: 'POST', body: { name, url } }),
  deleteArtifact: (ref: SessionRef, id: string) =>
    call<{ ok: true }>(`${base(ref)}/artifacts/${id}`, { method: 'DELETE' }),
  artifactUrl: (ref: SessionRef, id: string) =>
    `/api${base(ref)}/artifacts/${id}/content`,
  uploadFile: async (ref: SessionRef, file: File): Promise<Artifact> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`/api${base(ref)}/artifacts`, {
      method: 'POST',
      body: form,
      credentials: 'same-origin',
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, json?.error ?? 'upload failed');
    return json as Artifact;
  },

  outputKinds: (ref: SessionRef) => call<OutputKindInfo[]>(`${base(ref)}/output-kinds`),
  outputs: (ref: SessionRef) => call<Output[]>(`${base(ref)}/outputs`),
  createOutput: (ref: SessionRef, kind: string, name: string) =>
    call<Output>(`${base(ref)}/outputs`, { method: 'POST', body: { kind, name } }),
  renameOutput: (ref: SessionRef, id: string, name: string) =>
    call<{ ok: true }>(`${base(ref)}/outputs/${id}`, { method: 'PATCH', body: { name } }),
  deleteOutput: (ref: SessionRef, id: string) =>
    call<{ ok: true }>(`${base(ref)}/outputs/${id}`, { method: 'DELETE' }),
  addOutputFile: (ref: SessionRef, id: string, path: string) =>
    call<{ ok: true }>(`${base(ref)}/outputs/${id}/files`, { method: 'POST', body: { path } }),
  removeOutputFile: (ref: SessionRef, id: string, path: string) =>
    call<{ ok: true }>(`${base(ref)}/outputs/${id}/files?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    }),
  /** A route an output kind mounts for itself (ADR 0023), e.g. `/tex`. */
  kindGet: <T>(ref: SessionRef, path: string) => call<T>(`${base(ref)}${path}`),
  outputChanges: (ref: SessionRef, id: string) =>
    call<OutputEdit[]>(`${base(ref)}/outputs/${id}/changes`),
  recentAgentEdits: (ref: SessionRef) =>
    call<OutputEditSummary[]>(`${base(ref)}/output-edits`),

  invites: (ref: SessionRef) => call<InviteSummary[]>(`${base(ref)}/invites`),
  createInvite: (ref: SessionRef, body: { invitedEmail?: string } = {}) =>
    call<CreatedInviteView>(`${base(ref)}/invites`, { method: 'POST', body }),
  revokeInvite: (ref: SessionRef, id: string) =>
    call<{ ok: true }>(`${base(ref)}/invites/${id}/revoke`, { method: 'POST' }),
};

/* -------------------------------------------------------------- realtime */

/** Subscribes to the session event stream. Returns a teardown function. */
export function openStream(
  ref: SessionRef,
  onEvent: (event: ServerEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let ws: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  /** Set when the server refuses the stream; suppresses reconnection. */
  let refused = false;

  const connect = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/api${base(ref)}/stream`);

    ws.onopen = () => onStatus(true);
    ws.onmessage = (evt) => {
      try {
        const event = JSON.parse(evt.data as string) as ServerEvent;
        // A refusal is permanent: reconnecting would just loop.
        if (event.type === 'stream.error') refused = true;
        onEvent(event);
      } catch {
        // Ignore a malformed frame rather than tearing down the stream.
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (!closed && !refused) retry = setTimeout(connect, 1000);
    };
    ws.onerror = () => ws?.close();
  };

  connect();

  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    ws?.close();
  };
}
