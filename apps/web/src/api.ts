/**
 * API client.
 *
 * Requests go to a relative /api path: Vite proxies it in dev and it is
 * same-origin in production, so cookie-based auth behaves identically in both.
 */
import type {
  AgentSummary,
  AgentTrustPolicy,
  AuthUser,
  CreatedAgentView,
  CreatedInviteView,
  InviteSummary,
  LoginBody,
  Member,
  Message,
  Participant,
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

  tokens: (ref: SessionRef) => call<TokenSummary[]>(`${base(ref)}/tokens`),
  revokeToken: (ref: SessionRef, id: string) =>
    call<{ ok: true }>(`${base(ref)}/tokens/${id}/revoke`, { method: 'POST' }),

  context: (ref: SessionRef) => call<SessionContext>(`${base(ref)}/context`),
  updateContext: (ref: SessionRef, patch: Partial<SessionContext>) =>
    call<SessionContext>(`${base(ref)}/context`, { method: 'PATCH', body: patch }),

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
