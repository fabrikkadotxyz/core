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
  DeviceSummary,
  TemplateSummary,
  CatchUp,
  WaitingItem,
  HomeView,
  OutputComment,
  TeamDetail,
  AuditEventView,
  TeamMember,
  TeamSummary,
  PauseState,
  ServerEvent,
  SessionContext,
  SessionSummary,
  SessionView,
  SignupBody,
  NotifySetting,
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
    // ADR 0041: a deployment refused a write. Tell the shell, which shows why and where to go.
    if (res.status === 402) {
      const url = (json as { url?: string | null } | undefined)?.url ?? undefined;
      window.dispatchEvent(new CustomEvent('fabrikka:gated', { detail: { text: message, url } }));
    }
    throw new ApiError(res.status, message);
  }
  return json as T;
}

/* ----------------------------------------------------------------- themes */

/** A theme the instance offers (M44, ADR 0038). */
export interface ThemeInfo {
  id: string;
  name: string;
  description: string;
  author: string | null;
  license: string | null;
  scheme: 'light' | 'dark';
  swatches: string[];
  builtIn: boolean;
}

export const themes = {
  list: () => call<{ themes: ThemeInfo[]; default: string; system: { light: string; dark: string } }>('/themes'),
  mine: () => call<{ theme: string | null }>('/me/theme'),
  choose: (theme: string | null) => call<{ theme: string | null }>('/me/theme', { method: 'PUT', body: { theme } }),
};

/* -------------------------------------------------------- onboarding (M47) */

export type GettingStartedStep = 'computer' | 'room' | 'agent' | 'invite' | 'integration';
export interface GettingStarted {
  welcomed: boolean;
  dismissed: boolean;
  steps: { id: GettingStartedStep; done: boolean; optional: boolean }[];
  room: { ownerSlug: string; publicId: string } | null;
  /** The agent tools you said you use (AGENT_TOOLS ids and/or 'other'); null until asked. */
  agents: string[] | null;
  /** Agents you wish Fabrikka ran (WANTED_AGENTS ids, or a short free name). */
  wanted: string[];
}

export const onboarding = {
  get: () => call<GettingStarted>('/me/getting-started'),
  /** The welcome's Continue: saves the look (as Appearance does) and is never shown again. */
  welcome: (theme: string | null, agents?: string[], wanted?: string[]) =>
    call<{ ok: true }>('/me/welcome', { method: 'POST', body: { theme, ...(agents !== undefined ? { agents } : {}), ...(wanted !== undefined ? { wanted } : {}) } }),
  /** Change the agents you use, and wish for, any time, from Your devices. */
  setAgents: (agents: string[], wanted?: string[]) => call<{ ok: true }>('/me/agents', { method: 'PUT', body: { agents, ...(wanted !== undefined ? { wanted } : {}) } }),
  dismiss: () => call<{ ok: true }>('/me/getting-started/dismiss', { method: 'POST', body: {} }),
};

/* ------------------------------------------------------------------- auth */

export const auth = {
  me: () => call<{ user: AuthUser }>('/auth/me'),
  /** M58: `notice` when the sign-in cancelled a pending deletion. */
  login: (body: LoginBody) =>
    call<{ user: AuthUser; notice?: string }>('/auth/login', { method: 'POST', body }),
  /** M58 (ADR 0057): Settings → Account → Delete my account. Signs this browser out. */
  requestDeletion: (body: { password: string; eraseName: boolean }) =>
    call<{ ok: true; effectiveAt: string; graceDays: number }>('/me/deletion', { method: 'POST', body }),
  /** M60 (ADR 0058): what you did, and what was done to you. */
  myAudit: (limit = 50) => call<{ events: AuditEventView[] }>(`/me/audit?limit=${limit}`),
  /** M62: everything held about you, as one zip, behind the password. Resolves to the file. */
  exportMyData: async (password: string): Promise<{ blob: Blob; filename: string }> => {
    const res = await fetch('/api/me/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      throw new ApiError(res.status, json.error ?? `request failed (${res.status})`);
    }
    const filename = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'fabrikka-data.zip';
    return { blob: await res.blob(), filename };
  },
  logout: () => call<{ ok: true }>('/auth/logout', { method: 'POST' }),
  /** M39, ADR 0035: whether this instance still needs its owner, and creating them. */
  setupNeeded: () => call<{ needed: boolean }>('/setup'),
  setup: (body: { code: string; email: string; displayName: string; password: string }) =>
    call<{ user: AuthUser }>('/setup', { method: 'POST', body }),
  /** A session invite returns `session`; a team invite (M21) returns `team`. */
  signup: (body: SignupBody) =>
    call<{ user: AuthUser } & InviteDestination>('/auth/signup', { method: 'POST', body }),
  /** M32: what to offer — reset by email (a transport is configured), and a sign-up page if a deployment has one. M64: whether addresses are verified. */
  options: () => call<{ passwordReset: boolean; signupUrl: string | null; verifiesEmail: boolean }>('/auth/options'),
  /** M64: use a link from an email; no sign-in needed. */
  verify: (token: string) => call<{ ok: true; email: string; changed: boolean }>('/auth/verify', { method: 'POST', body: { token } }),
  resendVerification: () => call<{ ok: true; alreadyVerified?: boolean }>('/me/verification', { method: 'POST' }),
  changeEmail: (email: string, password: string) => call<{ ok: true; to: string }>('/me/email', { method: 'POST', body: { email, password } }),
  requestReset: (email: string) => call<{ ok: true }>('/auth/password-reset', { method: 'POST', body: { email } }),
  confirmReset: (token: string, password: string) =>
    call<{ ok: true }>('/auth/password-reset/confirm', { method: 'POST', body: { token, password } }),
};

/* --------------------------------------------------------------- invites */

/** Where redeeming an invite takes you: a session, or (M21) a team. */
export interface InviteDestination {
  session?: { ownerSlug: string; publicId: string };
  team?: { id: string; name: string };
}

export const invites = {
  /** Unauthenticated preview, so the invite page can name what it joins. */
  preview: (token: string) =>
    call<{ kind: 'session' | 'team'; title: string; invitedEmail: string | null; guest?: boolean; inviter?: string | null; oneOff?: boolean }>(`/invites/${token}`),
  redeem: (token: string) => call<InviteDestination>(`/invites/${token}/redeem`, { method: 'POST' }),
};

/* ---------------------------------------------------- personal integrations */

export const chats = {
  ofTeam: (teamId: string) => call<SessionSummary[]>(`/teams/${teamId}/chats`),
  create: (teamId: string, name: string) => call<SessionSummary>(`/teams/${teamId}/chats`, { method: 'POST', body: { name } }),
  /** Open (or create) the 1:1 chat with someone you share a team with. */
  direct: (userId: string) => call<SessionSummary>('/directs', { method: 'POST', body: { userId } }),
  people: () => call<{ id: string; displayName: string }[]>('/directs/people'),
};

/** M33: the command that installs this instance's client and connects a computer, or null if it serves none. */
export const client = {
  /** M55, M57: `appUrl` is the desktop app for this browser's platform when the instance serves one; `platforms` every one it has. */
  get: () => call<{ installCommand: string | null; installCommandWindows?: string | null; version: string | null; appUrl?: string | null; platforms?: string[] }>('/client'),
};

/** M31: your paired computers (the local host). Labels only, never paths. */
export const devices = {
  /** M54 (ADR 0052): ask one of your online computers to open its Folders window with an organization preselected. */
  openFolders: (deviceId: string, teamId: string) => call<{ ok: true }>(`/devices/${deviceId}/open-folders`, { method: 'POST', body: { teamId } }),
  list: () => call<DeviceSummary[]>('/devices'),
  revoke: (id: string) => call<{ ok: true }>(`/devices/${id}`, { method: 'DELETE' }),
  pairing: (code: string) => call<{ deviceName: string }>(`/devices/pair/${encodeURIComponent(code)}`),
  confirm: (code: string) => call<{ deviceName: string }>('/devices/pair/confirm', { method: 'POST', body: { code } }),
};

/** A vendor's mark: one SVG path in a 24×24 box, and its brand colour (checked by the server). */
export interface VendorLogo {
  path: string;
  color: string;
}

export interface CatalogueItem {
  id: string;
  name: string;
  category: string;
  description: string;
  connectionName: string | null;
  fields: { key: string; label: string; placeholder: string; required: boolean }[];
  presets: { read: number; write: number } | null;
  keywords: string[];
  logo: VendorLogo | null;
  /** Prepared but not yet verified: offered only where the instance asks for it. */
  preview: boolean;
  connected: boolean;
  status: string | null;
}

export interface PersonalConnection {
  id: string;
  slug: string;
  label: string;
  url: string;
  hasCredential: boolean;
  sessions: number;
  entry: string | null;
  auth: string;
  status: string;
  /** ADR 0043 (amended 2026-10-14): only this organization's rooms may use it; null for all your rooms. */
  teamId: string | null;
}

/**
 * Your connections (M28, M18). ADR 0043 (amended 2026-10-14): each is for all
 * your rooms (`team` null, the default) or for one organization only. `list`
 * with no team is every one you can use; with a team, exactly that scope.
 */
const scopeQuery = (team: string | null) => (team ? `?team=${encodeURIComponent(team)}` : '');
export const connections = {
  list: (team: string | null) =>
    call<{
      connections: PersonalConnection[];
      /** For organizations you've left: they no longer work anywhere. */
      orphaned: PersonalConnection[];
      encryptionConfigured: boolean;
    }>(`/me/connections${scopeQuery(team)}`),
  /** M18: vendors this instance offers, by category; `connected` in that scope. */
  catalogue: (team: string | null) =>
    call<{
      categories: Record<string, string>;
      entries: CatalogueItem[];
      unavailable: { id: string; name: string; category: string; keywords: string[]; logo: VendorLogo | null; missing: string[] }[];
      encryptionConfigured: boolean;
    }>(`/connections/catalogue${scopeQuery(team)}`),
  /** M18: begin signing in to a vendor; the browser then goes to `authorizeUrl`. */
  startOAuth: (entry: string, fields: Record<string, string> | undefined, teamId: string | null) =>
    call<{ authorizeUrl: string }>('/connections/oauth/start', { method: 'POST', body: { entry, fields, teamId } }),
  /** The desktop app's variant: a link it opens in the default browser (ADR 0033). */
  startHandoff: (entry: string, fields: Record<string, string> | undefined, teamId: string | null) =>
    call<{ handoffUrl: string }>('/connections/oauth/start', { method: 'POST', body: { entry, fields, handoff: true, teamId } }),
  /** `username` set: Basic sign-in (an email and an API token), sent as base64(username:credential). */
  save: (body: { slug: string; url: string; label?: string; credential?: string; username?: string; teamId: string | null }) =>
    call<{ id: string }>('/me/connections', { method: 'POST', body }),
  remove: (slug: string, team: string | null) =>
    call<{ ok: true }>(`/me/connections/${encodeURIComponent(slug)}${scopeQuery(team)}`, { method: 'DELETE' }),
  /** M52 (ADR 0049): the grants you usually allow, per integration. One name today, `default`. */
  grantDefaults: () => call<{ defaults: { slug: string; name: string; tools: string[]; updatedAt: string }[] }>('/me/grant-defaults'),
  saveGrantDefault: (slug: string, tools: string[]) =>
    call<{ ok: true; tools: number }>(`/me/grant-defaults/${encodeURIComponent(slug)}`, { method: 'PUT', body: { tools } }),
  removeGrantDefault: (slug: string) => call<{ ok: true }>(`/me/grant-defaults/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
};

/** M30: the team's shared connections. Owners manage them; members see they exist. */
export const teamConnections = {
  list: (teamId: string) =>
    call<{
      connections: { id: string; slug: string; label: string; url: string; hasCredential: boolean; addedBy: string | null; createdAt: string }[];
      canManage: boolean;
      uses: { slug: string; toolName: string; person: string | null; agent: string | null; session: string | null; ok: boolean; at: string }[];
      /** M43: how long who-used-what is kept, in days. */
      callRecordDays: number;
      encryptionConfigured: boolean;
    }>(`/teams/${teamId}/connections`),
  setCallRecordDays: (teamId: string, days: number) =>
    call<{ callRecordDays: number }>(`/teams/${teamId}/call-records`, { method: 'PUT', body: { days } }),
  save: (teamId: string, body: { slug: string; url: string; label?: string; credential?: string }) =>
    call<{ id: string }>(`/teams/${teamId}/connections`, { method: 'POST', body }),
  remove: (teamId: string, slug: string) =>
    call<{ ok: true }>(`/teams/${teamId}/connections/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
};

/* ------------------------------------------------------------- templates */

export const templates = {
  list: () => call<TemplateSummary[]>('/templates'),
  remove: (ref: string) => call<{ ok: true }>(`/templates/${encodeURIComponent(ref)}`, { method: 'DELETE' }),
};

/* ----------------------------------------------------------------- teams */

/** M63: an organization's retention, as its owners see it. */
export interface RetentionView {
  messageDays: number | null;
  outputDays: number | null;
  fileDays: number | null;
  choices: readonly number[];
}

export const teams = {
  list: () => call<TeamSummary[]>('/teams'),
  create: (name: string) => call<TeamSummary>('/teams', { method: 'POST', body: { name } }),
  get: (id: string) => call<TeamDetail>(`/teams/${id}`),
  createInvite: (id: string) => call<CreatedInviteView>(`/teams/${id}/invites`, { method: 'POST', body: {} }),
  /** M60 (ADR 0058): the organization's trail, for its owners; 404 for anyone else. */
  audit: (id: string, action?: string) =>
    call<{ events: AuditEventView[]; auditDays: number; choices: readonly number[] }>(`/teams/${id}/audit${action ? `?action=${encodeURIComponent(action)}` : ''}`),
  setAuditDays: (id: string, days: number) => call<{ auditDays: number }>(`/teams/${id}/audit-days`, { method: 'PUT', body: { days } }),
  /** M63: how long the organization's rooms keep messages, documents and files; null is forever. Owners only. */
  retention: (id: string) => call<RetentionView>(`/teams/${id}/retention`),
  setRetention: (id: string, policy: Partial<Pick<RetentionView, 'messageDays' | 'outputDays' | 'fileDays'>>) =>
    call<RetentionView & { pruned: { messages: number; outputs: number; files: number } }>(`/teams/${id}/retention`, { method: 'PUT', body: policy }),
  removeMember: (id: string, userId: string) =>
    call<{ ok: true }>(`/teams/${id}/members/${userId}`, { method: 'DELETE' }),
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
  /** M53 (ADR 0051): in an organization (unnamed: your own); `team` visibility starts one the organization reads along. */
  create: (title: string, teamId?: string, visibility: 'private' | 'team' = 'private', templateRef?: string) =>
    call<SessionSummary>('/sessions', { method: 'POST', body: { title, teamId, visibility, templateRef } }),
  /** M29: start a session from a chat — it links back; nothing is copied. */
  spinOff: (ref: SessionRef, title: string) =>
    call<SessionSummary>(`${base(ref)}/spin-off`, { method: 'POST', body: { title } }),
  /** M27: the export download — a plain link, so the browser handles the file. */
  exportUrl: (ref: SessionRef) => `/api${base(ref)}/export`,
  /** M25: the template this session started from, and saving it as one. */
  template: (ref: SessionRef) => call<TemplateSummary | null>(`${base(ref)}/template`),
  saveTemplate: (ref: SessionRef, body: { name: string; description?: string; teamId?: string | null }) =>
    call<TemplateSummary>(`${base(ref)}/template`, { method: 'POST', body }),
  /** M21: the session's team, who can be added from it, and adding them. */
  team: (ref: SessionRef) => call<{ id: string; name: string } | null>(`${base(ref)}/team`),
  roster: (ref: SessionRef) => call<TeamMember[]>(`${base(ref)}/roster`),
  addFromRoster: (ref: SessionRef, userId: string) =>
    call<{ ok: true }>(`${base(ref)}/members`, { method: 'POST', body: { userId } }),
  get: (ref: SessionRef) => call<SessionView>(base(ref)),
  update: (ref: SessionRef, body: { title?: string; status?: 'active' | 'archived'; visibility?: 'private' | 'team' }) =>
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
  /** M31: an agent that runs on one of your paired computers, in a granted folder. */
  /** M35: `provider` picks Claude Code, Codex or OpenCode when the computer has more than one. */
  addHostAgent: (ref: SessionRef, body: { deviceId: string; grantId: string; displayName?: string; provider?: string }) =>
    call<{ agent: { displayName: string }; online: boolean }>(`${base(ref)}/agents/host`, { method: 'POST', body }),
  agentHosts: (ref: SessionRef) =>
    call<Record<string, { deviceName: string; label: string | null; online: boolean; fromPersonal?: boolean }>>(`${base(ref)}/agents/hosts`),
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
      /** M28: your saved connections not yet in this session (ADR 0043: only the room's organization's). */
      available: { id: string; slug: string; label: string; url: string; hasCredential: boolean; teamId: string | null }[];
      /** M30: the team's shared connections that apply to you here. */
      team: { slug: string; label: string; teamName: string; hasCredential: boolean; overridden: boolean }[];
      inSession: { slug: string; label: string; attachedBy: number }[];
      grants: { serverSlug: string; toolName: string; allowed: boolean }[];
      encryptionConfigured: boolean;
    }>(`${base(ref)}/integrations`),
  attachIntegration: (
    ref: SessionRef,
    // No url: attach a connection you already saved (M28).
    body: { slug: string; label?: string; url?: string; credential?: string },
  ) => call<unknown>(`${base(ref)}/integrations`, { method: 'POST', body }),
  detachIntegration: (ref: SessionRef, slug: string) =>
    call<{ ok: true }>(`${base(ref)}/integrations/${slug}`, { method: 'DELETE' }),
  integrationTools: (ref: SessionRef, slug: string) =>
    call<{ name: string; description?: string }[]>(
      `${base(ref)}/integrations/${slug}/tools`,
    ),
  /** M18: a catalogue connection's preset — none, read, or read & write — over the per-tool grants. */
  setPreset: (ref: SessionRef, slug: string, preset: 'none' | 'read' | 'write') =>
    call<{ ok: true }>(`${base(ref)}/integrations/${slug}/preset`, { method: 'PUT', body: { preset } }),
  setToolGrant: (ref: SessionRef, slug: string, tool: string, allowed: boolean) =>
    call<{ ok: true }>(`${base(ref)}/integrations/${slug}/tools/${tool}`, {
      method: 'PUT',
      body: { allowed },
    }),
  /** M52: make this room's grants for a connection exactly your saved default. Owner-only. */
  applyGrantDefault: (ref: SessionRef, slug: string) =>
    call<{ ok: true; allowed: number }>(`${base(ref)}/integrations/${slug}/grants/apply-default`, { method: 'POST', body: {} }),

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
  /** `role: 'guest'` (M22): a view-only invite to this one session. */
  createInvite: (ref: SessionRef, body: { invitedEmail?: string; role?: 'guest'; reusable?: boolean } = {}) =>
    call<CreatedInviteView>(`${base(ref)}/invites`, { method: 'POST', body }),
  /** M24: what changed since you last looked, and marking that you've looked. */
  catchUp: (ref: SessionRef) => call<CatchUp>(`${base(ref)}/catch-up`),
  seen: (ref: SessionRef) => call<{ ok: true }>(`${base(ref)}/seen`, { method: 'POST' }),
  /** M42: how much of this room reaches you; null is the room kind's default. */
  setNotify: (ref: SessionRef, notify: NotifySetting | null) =>
    call<{ notify: NotifySetting }>(`${base(ref)}/notify`, { method: 'PUT', body: { notify } }),
  /** Leaving: must survive the page going away, so it can't wait for a response. */
  seenOnLeave: (ref: SessionRef) => {
    void fetch(`/api${base(ref)}/seen`, { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => {});
  },
  /** M24: mentions of you across your sessions, since you last opened each. */
  waiting: () => call<WaitingItem[]>('/waiting'),
  /** M56: the home, in one answer. */
  home: () => call<HomeView>('/me/home'),
  /** M23: comments on an output. Viewers and guests may write these. */
  comments: (ref: SessionRef, outputId: string) => call<OutputComment[]>(`${base(ref)}/outputs/${outputId}/comments`),
  addComment: (ref: SessionRef, outputId: string, body: { quote: string; body: string; file?: string }) =>
    call<{ id: string }>(`${base(ref)}/outputs/${outputId}/comments`, { method: 'POST', body }),
  replyComment: (ref: SessionRef, outputId: string, commentId: string, body: string) =>
    call<{ id: string }>(`${base(ref)}/outputs/${outputId}/comments/${commentId}/replies`, { method: 'POST', body: { body } }),
  setCommentResolved: (ref: SessionRef, outputId: string, commentId: string, resolved: boolean) =>
    call<{ ok: true }>(`${base(ref)}/outputs/${outputId}/comments/${commentId}/${resolved ? 'resolve' : 'reopen'}`, {
      method: 'POST',
    }),
  removeGuest: (ref: SessionRef, userId: string) =>
    call<{ ok: true }>(`${base(ref)}/guests/${userId}`, { method: 'DELETE' }),
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
