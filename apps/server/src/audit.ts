/**
 * The trail (M60, ADR 0058): who did what, kept per organization, never what
 * they said.
 *
 * One writer, `audit()`. It records ids, names and outcomes, and it never
 * throws into the action it describes: a trail that could break a sign-in
 * would be switched off the first time it did. Names resolve at read time, so
 * a person who left under `former-member` (ADR 0057) stops being named without
 * a rewrite. docs/security.md "The trail", docs/operations.md.
 */
import { and, desc, eq, gte, isNull, like, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '@fabrikka/db';
import { auditEvents, sessions, teams, users } from '@fabrikka/db';
import type { AuditEventView } from '@fabrikka/types';

/** The fixed list. Adding to it is a doc change first (docs/security.md). */
export const AUDIT_ACTIONS = [
  'login.ok',
  'login.failed',
  'login.locked',
  'logout',
  'password.reset_requested',
  'password.reset_completed',
  'account.deactivated',
  'account.reactivated',
  'account.deletion_requested',
  'account.deletion_cancelled',
  'account.deleted',
  'account.exported',
  'team.created',
  'team.member_removed',
  'team.audit_days_changed',
  'team.retention_changed',
  'retention.pruned',
  'invite.created',
  'invite.revoked',
  'invite.redeemed',
  'session.deleted',
  'session.exported',
  'member.added',
  'member.removed',
  'guest.removed',
  'agent.added',
  'agent.trust_changed',
  'agents.paused',
  'agents.resumed',
  'token.issued',
  'token.revoked',
  'connection.attached',
  'connection.removed',
  'grant.changed',
  'admin.create_user',
  'admin.reset_password',
  'admin.deactivate_user',
  'admin.reactivate_user',
  'admin.delete_user',
  'admin.backup',
  'admin.restore',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number] | `deployment.${string}`;

export type ActorKind = 'user' | 'operator' | 'system' | 'deployment';
export type Outcome = 'ok' | 'refused' | 'failed';

export interface AuditInput {
  action: AuditAction;
  actorKind?: ActorKind;
  actorUserId?: string | null;
  subjectUserId?: string | null;
  teamId?: string | null;
  /** With a session and no team, the session's organization is filled in. */
  sessionId?: string | null;
  detail?: Record<string, string | number | boolean | null | undefined>;
  ip?: string | null;
  outcome?: Outcome;
}

/** Days an organization may keep its trail. A fixed list, so the privacy policy can name every answer. */
export const AUDIT_DAYS = [90, 180, 365, 730] as const;

/** Events in no organization (a sign-in, a personal connection) follow the instance. */
export const INSTANCE_AUDIT_DAYS = (() => {
  const n = Number(process.env.FABRIKKA_AUDIT_DAYS ?? 365);
  return Number.isInteger(n) && n > 0 ? n : 365;
})();

/** Record one event. Never throws: a failure is one warning line, and the action it describes stands. */
export async function audit(db: Database, e: AuditInput): Promise<void> {
  try {
    let teamId = e.teamId ?? null;
    if (!teamId && e.sessionId) {
      const [s] = await db.select({ teamId: sessions.teamId }).from(sessions).where(eq(sessions.id, e.sessionId)).limit(1);
      teamId = s?.teamId ?? null;
    }
    const detail = e.detail ? Object.fromEntries(Object.entries(e.detail).filter(([, v]) => v !== undefined)) : null;
    await db.insert(auditEvents).values({
      action: e.action,
      actorKind: e.actorKind ?? (e.actorUserId ? 'user' : 'system'),
      actorUserId: e.actorUserId ?? null,
      subjectUserId: e.subjectUserId ?? null,
      teamId,
      sessionId: e.sessionId ?? null,
      detail: detail as Record<string, string | number | boolean | null> | null,
      ip: e.ip ?? null,
      outcome: e.outcome ?? 'ok',
    });
  } catch (err) {
    console.warn(`[trail] could not record ${e.action}: ${(err as Error).message}`);
  }
}

export interface AuditFilter {
  /** Newest first; at most this many. */
  limit?: number;
  /** Only events before this instant (paging back). */
  before?: Date;
  /** Only events whose action starts with this (`login`, `member`, `deployment`). */
  action?: string;
  /** Only events since this instant. */
  since?: Date;
}

const actor = alias(users, 'actor');
const subject = alias(users, 'subject');

function baseQuery(db: Database) {
  return db
    .select({
      id: auditEvents.id,
      at: auditEvents.at,
      action: auditEvents.action,
      actorKind: auditEvents.actorKind,
      actorUserId: auditEvents.actorUserId,
      actorName: actor.displayName,
      subjectUserId: auditEvents.subjectUserId,
      subjectName: subject.displayName,
      teamId: auditEvents.teamId,
      teamName: teams.name,
      sessionPublicId: sessions.publicId,
      sessionTitle: sessions.title,
      detail: auditEvents.detail,
      ip: auditEvents.ip,
      outcome: auditEvents.outcome,
    })
    .from(auditEvents)
    .leftJoin(actor, eq(actor.id, auditEvents.actorUserId))
    .leftJoin(subject, eq(subject.id, auditEvents.subjectUserId))
    .leftJoin(teams, eq(teams.id, auditEvents.teamId))
    .leftJoin(sessions, eq(sessions.id, auditEvents.sessionId));
}

function filterSql(f: AuditFilter) {
  const parts = [];
  if (f.before) parts.push(lt(auditEvents.at, f.before));
  if (f.since) parts.push(gte(auditEvents.at, f.since));
  if (f.action) parts.push(like(auditEvents.action, `${f.action.replace(/[%_]/g, '')}%`));
  return parts;
}

type Row = Awaited<ReturnType<ReturnType<typeof baseQuery>['execute']>>[number];

function toView(r: Row): AuditEventView {
  return {
    id: r.id,
    at: r.at.toISOString(),
    action: r.action,
    actor: { kind: r.actorKind as ActorKind, userId: r.actorUserId, name: r.actorName },
    subject: r.subjectUserId ? { userId: r.subjectUserId, name: r.subjectName } : null,
    team: r.teamId ? { id: r.teamId, name: r.teamName } : null,
    session: r.sessionPublicId ? { publicId: r.sessionPublicId, title: r.sessionTitle } : null,
    detail: (r.detail ?? {}) as Record<string, string | number | boolean | null>,
    ip: r.ip,
    outcome: r.outcome as Outcome,
  };
}

const cap = (n: number | undefined) => Math.min(Math.max(n ?? 200, 1), 1000);

/** An organization's trail: events in it or in its rooms. For its owners. */
export async function auditForTeam(db: Database, teamId: string, f: AuditFilter = {}): Promise<AuditEventView[]> {
  const rows = await baseQuery(db)
    .where(and(eq(auditEvents.teamId, teamId), ...filterSql(f)))
    .orderBy(desc(auditEvents.at))
    .limit(cap(f.limit));
  return rows.map(toView);
}

/** A person's trail: what they did, and what was done to them, anywhere. */
export async function auditForUser(db: Database, userId: string, f: AuditFilter = {}): Promise<AuditEventView[]> {
  const rows = await baseQuery(db)
    .where(and(or(eq(auditEvents.actorUserId, userId), eq(auditEvents.subjectUserId, userId)), ...filterSql(f)))
    .orderBy(desc(auditEvents.at))
    .limit(cap(f.limit));
  return rows.map(toView);
}

/** Everything, for the operator's CLI. */
export async function auditForInstance(db: Database, f: AuditFilter & { teamId?: string } = {}): Promise<AuditEventView[]> {
  const parts = filterSql(f);
  if (f.teamId) parts.push(eq(auditEvents.teamId, f.teamId));
  const rows = await baseQuery(db)
    .where(parts.length ? and(...parts) : undefined)
    .orderBy(desc(auditEvents.at))
    .limit(cap(f.limit));
  return rows.map(toView);
}

export async function getAuditDays(db: Database, teamId: string): Promise<number> {
  const [t] = await db.select({ days: teams.auditDays }).from(teams).where(eq(teams.id, teamId)).limit(1);
  return t?.days ?? 365;
}

/** Shortening prunes at once, so the setting is true the moment it is made. */
export async function setAuditDays(db: Database, teamId: string, days: number): Promise<void> {
  await db.update(teams).set({ auditDays: days }).where(eq(teams.id, teamId));
  await pruneAudit(db, teamId);
}

/** Delete events past their organization's setting, or the instance's for events in none. Daily. */
export async function pruneAudit(db: Database, teamId?: string): Promise<number> {
  const inTeams = await db.execute<{ id: string }>(sql`
    delete from audit_events e
    using teams t
    where e.team_id = t.id
      and e.at < now() - make_interval(days => t.audit_days)
      ${teamId ? sql`and t.id = ${teamId}` : sql``}
    returning e.id`);
  let n = inTeams.length;
  if (!teamId) {
    const cutoff = new Date(Date.now() - INSTANCE_AUDIT_DAYS * 86_400_000);
    const loose = await db
      .delete(auditEvents)
      .where(and(isNull(auditEvents.teamId), lt(auditEvents.at, cutoff)))
      .returning({ id: auditEvents.id });
    n += loose.length;
  }
  return n;
}

/** The CSV an owner downloads. One row per event, RFC 4180 quoting, detail as JSON. */
export function auditCsv(events: AuditEventView[]): string {
  const q = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const who = (e: AuditEventView) => (e.actor.userId ? e.actor.name ?? e.actor.userId : e.actor.kind);
  const lines = [['at', 'action', 'outcome', 'actor', 'subject', 'organization', 'room', 'ip', 'detail'].join(',')];
  for (const e of events) {
    lines.push(
      [e.at, e.action, e.outcome, who(e), e.subject?.name ?? e.subject?.userId ?? '', e.team?.name ?? '', e.session?.title ?? '', e.ip ?? '', JSON.stringify(e.detail)]
        .map(q)
        .join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

/** The account an address names, if any, so a failed sign-in can carry its subject. Never changes the answer. */
export async function userIdFor(db: Database, email: string): Promise<string | null> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.trim().toLowerCase())).limit(1);
  return u?.id ?? null;
}
