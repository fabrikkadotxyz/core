/**
 * Retention (M63, ADR 0058 amended): how long an organization keeps what its
 * rooms hold. Messages by when they were written, documents by when they were
 * last edited, uploaded files by when they were added. Each is off (forever)
 * until an owner, or a deployment through the kit, sets it; each is one of a
 * fixed list, so the privacy policy can name every answer. A daily job
 * deletes past the windows, and shortening a window deletes at once. Every
 * run that removed something is in the trail. docs/operations.md.
 */
import { eq, sql } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { teams } from '@fabrikka/db';
import { audit } from './audit.ts';

export const RETENTION_DAYS = [30, 90, 180, 365, 730] as const;

export interface RetentionPolicy {
  /** Messages, by when they were written. */
  messageDays: number | null;
  /** Documents (outputs), by when they were last edited. */
  outputDays: number | null;
  /** Uploaded files (artifacts), by when they were added. */
  fileDays: number | null;
}

export interface Pruned {
  messages: number;
  outputs: number;
  files: number;
}

export async function getRetention(db: Database, teamId: string): Promise<RetentionPolicy | null> {
  const [t] = await db.select({ messageDays: teams.messageDays, outputDays: teams.outputDays, fileDays: teams.fileDays }).from(teams).where(eq(teams.id, teamId)).limit(1);
  return t ?? null;
}

const valid = (v: unknown): v is number | null => v === null || (RETENTION_DAYS as readonly number[]).includes(v as number);

/** Set any of the three; an absent key keeps its value. Prunes the organization at once. */
export async function setRetention(
  db: Database,
  teamId: string,
  policy: Partial<RetentionPolicy>,
): Promise<{ ok: true; policy: RetentionPolicy; pruned: Pruned } | { ok: false; error: string }> {
  for (const k of ['messageDays', 'outputDays', 'fileDays'] as const) {
    if (k in policy && !valid(policy[k])) return { ok: false, error: `${k} is one of ${RETENTION_DAYS.join(', ')} days, or null for forever` };
  }
  const set: Partial<RetentionPolicy> = {};
  if ('messageDays' in policy) set.messageDays = policy.messageDays ?? null;
  if ('outputDays' in policy) set.outputDays = policy.outputDays ?? null;
  if ('fileDays' in policy) set.fileDays = policy.fileDays ?? null;
  if (Object.keys(set).length) await db.update(teams).set(set).where(eq(teams.id, teamId));
  const pruned = (await pruneRetention(db, teamId)).get(teamId) ?? { messages: 0, outputs: 0, files: 0 };
  return { ok: true, policy: (await getRetention(db, teamId))!, pruned };
}

/**
 * Delete what is past its organization's windows: one organization, or all.
 * Returns what went, per organization, and records one trail event per
 * organization that lost something. Blobs of deleted files stay on disk, as
 * when a file is removed by hand (artifacts.ts): another file may share them.
 */
export async function pruneRetention(db: Database, teamId?: string): Promise<Map<string, Pruned>> {
  const only = teamId ? sql`and t.id = ${teamId}` : sql``;
  const messages = await db.execute<{ team_id: string; n: string }>(sql`
    with gone as (
      delete from messages m
      using sessions s, teams t
      where m.session_id = s.id and s.team_id = t.id
        and t.message_days is not null
        and m.created_at < now() - make_interval(days => t.message_days)
        ${only}
      returning t.id as team_id
    )
    select team_id, count(*)::text as n from gone group by team_id`);
  const outputs = await db.execute<{ team_id: string; n: string }>(sql`
    with gone as (
      delete from outputs o
      using sessions s, teams t
      where o.session_id = s.id and s.team_id = t.id
        and t.output_days is not null
        and o.updated_at < now() - make_interval(days => t.output_days)
        ${only}
      returning t.id as team_id
    )
    select team_id, count(*)::text as n from gone group by team_id`);
  const files = await db.execute<{ team_id: string; n: string }>(sql`
    with gone as (
      delete from artifacts a
      using sessions s, teams t
      where a.session_id = s.id and s.team_id = t.id
        and t.file_days is not null
        and a.created_at < now() - make_interval(days => t.file_days)
        ${only}
      returning t.id as team_id
    )
    select team_id, count(*)::text as n from gone group by team_id`);

  const out = new Map<string, Pruned>();
  const bump = (rows: { team_id: string; n: string }[], key: keyof Pruned) => {
    for (const r of rows) {
      const p = out.get(r.team_id) ?? { messages: 0, outputs: 0, files: 0 };
      p[key] += Number(r.n);
      out.set(r.team_id, p);
    }
  };
  bump([...messages], 'messages');
  bump([...outputs], 'outputs');
  bump([...files], 'files');
  for (const [id, p] of out) {
    await audit(db, { action: 'retention.pruned', actorKind: 'system', teamId: id, detail: { ...p } });
  }
  return out;
}

/** The daily job's one-line summary. */
export function summarize(pruned: Map<string, Pruned>): string | null {
  let m = 0;
  let o = 0;
  let f = 0;
  for (const p of pruned.values()) {
    m += p.messages;
    o += p.outputs;
    f += p.files;
  }
  if (!m && !o && !f) return null;
  return `${m} message(s), ${o} document(s), ${f} file(s) in ${pruned.size} organization(s)`;
}
