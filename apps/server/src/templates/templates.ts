/**
 * Session templates (M25): a session's structure without its content.
 * See docs/data-model.md.
 *
 * Saving copies exactly the structure — objective, constraints, open questions,
 * outputs as they stand, recommended connections — and never messages, facts,
 * decisions, links, artifacts, members, agents or credentials.
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { sessions, sessionTemplates, teamMembers, teams } from '@fabrikka/db';
import type { TemplateBody, TemplateSummary } from '@fabrikka/types';
import { createOutput, listOutputs, readOutput } from '../outputs/core.ts';
import { getSessionContext, updateSessionContext } from '../sessions.ts';
import { BUILTIN_TEMPLATES } from './registry.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TemplateError extends Error {}

export async function listTemplates(db: Database, userId: string): Promise<TemplateSummary[]> {
  const myTeams = db.select({ id: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId));
  const ownerOf = new Set(
    (
      await db
        .select({ id: teamMembers.teamId })
        .from(teamMembers)
        .where(and(eq(teamMembers.userId, userId), eq(teamMembers.role, 'owner')))
    ).map((r) => r.id),
  );
  const rows = await db
    .select({ t: sessionTemplates, teamName: teams.name })
    .from(sessionTemplates)
    .leftJoin(teams, eq(teams.id, sessionTemplates.teamId))
    .where(
      or(
        and(eq(sessionTemplates.ownerUserId, userId), isNull(sessionTemplates.teamId)),
        inArray(sessionTemplates.teamId, myTeams),
      ),
    );
  return [
    ...BUILTIN_TEMPLATES.map((b) => ({
      ref: `builtin:${b.id}`,
      name: b.name,
      description: b.description,
      source: 'builtin' as const,
      canDelete: false,
      body: b.body,
    })),
    ...rows.map(({ t, teamName }) => ({
      ref: t.id,
      name: t.name,
      description: t.description,
      source: (t.teamId ? 'team' : 'mine') as 'team' | 'mine',
      ...(teamName ? { teamName } : {}),
      canDelete: t.ownerUserId === userId || (t.teamId !== null && ownerOf.has(t.teamId)),
      body: t.body as TemplateBody,
    })),
  ];
}

/** A template the user may use, by ref — or null, which every caller treats as 404. */
export async function findTemplate(db: Database, userId: string, ref: string): Promise<TemplateSummary | null> {
  return (await listTemplates(db, userId)).find((t) => t.ref === ref) ?? null;
}

/** Fill a brand-new session with a template's structure. */
export async function applyTemplate(
  db: Database,
  opts: { sessionId: string; participantId: string; template: TemplateSummary },
): Promise<void> {
  const { body } = opts.template;
  await db.update(sessions).set({ templateRef: opts.template.ref }).where(eq(sessions.id, opts.sessionId));
  await updateSessionContext(db, opts.sessionId, {
    ...(body.objective ? { objective: body.objective } : {}),
    add: { constraints: body.constraints, questions: body.questions },
  });
  for (const o of body.outputs) {
    // An output kind this instance lacks (no TeX here, say) is skipped, not fatal.
    await createOutput(db, {
      sessionId: opts.sessionId,
      participantId: opts.participantId,
      kind: o.kind,
      name: o.name,
      content: o.content,
    }).catch(() => {});
  }
}

/** Save a session's structure as a template, for yourself or a team you're on. */
export async function saveTemplate(
  db: Database,
  opts: { sessionId: string; userId: string; name: string; description?: string; teamId?: string | null },
): Promise<TemplateSummary> {
  const name = opts.name.trim().slice(0, 80);
  if (!name) throw new TemplateError('a template needs a name');
  if (opts.teamId) {
    const onTeam = await db
      .select({ u: teamMembers.userId })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, opts.teamId), eq(teamMembers.userId, opts.userId)))
      .limit(1);
    if (!onTeam.length) throw new TemplateError('no such team');
  }

  const ctx = await getSessionContext(db, opts.sessionId);
  const outputs: TemplateBody['outputs'] = [];
  for (const o of await listOutputs(db, opts.sessionId)) {
    const read = await readOutput(db, opts.sessionId, o.id, { maxLines: 100_000 }).catch(() => null);
    if (read) outputs.push({ kind: o.kind, name: o.name, content: read.content });
  }
  const [base] = await db.select({ templateRef: sessions.templateRef }).from(sessions).where(eq(sessions.id, opts.sessionId));
  const inherited = base?.templateRef ? await findTemplate(db, opts.userId, base.templateRef) : null;

  const body: TemplateBody = {
    objective: ctx.objective ?? '',
    constraints: ctx.constraints,
    questions: ctx.questions,
    outputs,
    connections: inherited?.body.connections ?? [],
  };
  const [row] = await db
    .insert(sessionTemplates)
    .values({ name, description: opts.description?.trim().slice(0, 300) ?? '', ownerUserId: opts.userId, teamId: opts.teamId ?? null, body })
    .returning();
  return (await findTemplate(db, opts.userId, row!.id))!;
}

export async function deleteTemplate(db: Database, userId: string, ref: string): Promise<boolean> {
  if (!UUID.test(ref)) return false;
  const t = await findTemplate(db, userId, ref);
  if (!t || !t.canDelete) return false;
  await db.delete(sessionTemplates).where(eq(sessionTemplates.id, ref));
  return true;
}

/** The template a session started from, for "suggested connections". */
export async function sessionTemplate(db: Database, userId: string, sessionId: string): Promise<TemplateSummary | null> {
  const [row] = await db.select({ ref: sessions.templateRef }).from(sessions).where(eq(sessions.id, sessionId));
  return row?.ref ? findTemplate(db, userId, row.ref) : null;
}
