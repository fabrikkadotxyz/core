/**
 * Export a session (M27): the record is yours. See docs/data-model.md.
 *
 * One zip: README.md (the session as one readable document), session.json (the
 * same, for programs), each output's files with its changes log and comments,
 * the artifacts, and the timeline. Never agent activity (ADR 0015), never a
 * credential. Nothing in it needs Fabrikka to read.
 */
import { asc, eq } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { contextEvents, participants } from '@fabrikka/db';
import { listArtifacts, readArtifact } from './artifacts.ts';
import { listLinks } from './links.ts';
import { renderMentions } from './mentions.ts';
import { listComments } from './outputs/comments.ts';
import { listEdits, listOutputs, readOutput } from './outputs/core.ts';
import { getSessionContext, listMessages, listParticipants } from './sessions.ts';
import { zip } from './zip.ts';

const day = (iso: string | Date) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
/** A file or folder name that is safe on every OS and still recognisable. */
const slug = (s: string) => s.trim().replace(/[\\/:*?"<>|\0]+/g, '-').replace(/\s+/g, ' ').slice(0, 80) || 'untitled';

export async function exportSession(
  db: Database,
  opts: { sessionId: string; session: { title: string; publicId: string; ownerSlug: string; createdAt: string }; exportedBy: string },
): Promise<{ filename: string; data: Buffer }> {
  const { sessionId } = opts;
  const exportedAt = new Date().toISOString();
  const people = await listParticipants(db, sessionId);
  const ctx = await getSessionContext(db, sessionId);

  const history = await db
    .select({ e: contextEvents, who: participants.displayName })
    .from(contextEvents)
    .leftJoin(participants, eq(participants.id, contextEvents.participantId))
    .where(eq(contextEvents.sessionId, sessionId))
    .orderBy(asc(contextEvents.createdAt), asc(contextEvents.seq));
  /** The latest "add" of an item: who put it there, and when. */
  const provenance = (field: string, value: string) => {
    const hit = [...history].reverse().find((h) => h.e.field === field && h.e.op === 'add' && h.e.value === value);
    return hit ? `@${hit.who ?? 'a template'}, ${day(hit.e.createdAt)}` : 'recorded before history was kept';
  };

  const files: { path: string; data: Buffer | string }[] = [];

  // Outputs: current files, changes log, comments.
  const outputs = [];
  const usedOutputNames = new Set<string>();
  for (const o of await listOutputs(db, sessionId)) {
    let dir = slug(o.name);
    for (let n = 2; usedOutputNames.has(dir); n++) dir = `${slug(o.name)} (${n})`;
    usedOutputNames.add(dir);
    const texts: Record<string, string> = {};
    for (const f of o.files) {
      const r = await readOutput(db, sessionId, o.id, { file: f, maxLines: 1_000_000 }).catch(() => null);
      if (!r) continue;
      texts[f] = r.content;
      files.push({ path: `outputs/${dir}/${f}`, data: r.content });
    }
    const changes = (await listEdits(db, sessionId, { outputId: o.id, limit: 500 })).reverse();
    const comments = await listComments(db, sessionId, o.id).catch(() => []);
    files.push({
      path: `outputs/${dir}/CHANGES.md`,
      data:
        `# Changes to ${o.name}\n\nOldest first. Every edit, with who made it.\n\n` +
        changes
          .map((e) => `## ${day(e.at)} — @${e.displayName}${e.runId ? ' (agent run)' : ''} · ${e.file} · +${e.added} −${e.removed}\n\n\`\`\`diff\n${e.diff}\n\`\`\`\n`)
          .join('\n'),
    });
    if (comments.length) {
      files.push({
        path: `outputs/${dir}/COMMENTS.md`,
        data:
          `# Comments on ${o.name}\n\n` +
          comments
            .map(
              (c) =>
                `> ${c.quote.replace(/\n/g, '\n> ')}\n\n**@${c.author}**, ${day(c.createdAt)}${c.status === 'resolved' ? ` — resolved${c.resolvedBy ? ` by @${c.resolvedBy}` : ''}` : c.outdated ? ' — outdated' : ''}\n\n${c.body}\n` +
                c.replies.map((r) => `\n- **@${r.author}**, ${day(r.createdAt)}: ${r.body}`).join('') +
                '\n',
            )
            .join('\n---\n\n'),
      });
    }
    outputs.push({ name: o.name, kind: o.kind, folder: `outputs/${dir}`, mainFile: o.mainFile, version: o.version, files: texts, changes, comments });
  }

  // Artifacts: the files themselves, and links by URL.
  const artifacts = [];
  const usedArtifactNames = new Set<string>();
  for (const a of await listArtifacts(db, sessionId)) {
    if (a.type === 'link') {
      artifacts.push({ name: a.name, type: 'link', url: a.url, by: a.createdBy.displayName, at: a.createdAt });
      continue;
    }
    const read = await readArtifact(db, sessionId, a.id);
    if (!read) continue;
    let name = slug(a.name);
    for (let n = 2; usedArtifactNames.has(name); n++) name = `${n}-${slug(a.name)}`;
    usedArtifactNames.add(name);
    files.push({ path: `artifacts/${name}`, data: read.content });
    artifacts.push({ name: a.name, type: 'file', path: `artifacts/${name}`, by: a.createdBy.displayName, at: a.createdAt });
  }

  const links = await listLinks(db, sessionId);
  const msgs = await listMessages(db, sessionId, { limit: 1_000_000 });
  const timeline = msgs.map((m) => ({ author: m.author.displayName, at: m.createdAt, text: renderMentions(m.content, people) }));
  files.push({
    path: 'timeline.md',
    data: `# Timeline\n\n` + timeline.map((m) => `**@${m.author}** — ${day(m.at)}\n\n${m.text}\n`).join('\n'),
  });

  const list = (field: 'decisions' | 'facts' | 'questions' | 'constraints', title: string) =>
    ctx[field].length ? `## ${title}\n\n` + ctx[field].map((v) => `- ${v} — *${provenance(field, v)}*`).join('\n') + '\n\n' : '';

  const readme =
    `# ${opts.session.title}\n\n` +
    `Exported by @${opts.exportedBy} on ${day(exportedAt)} from Fabrikka. ` +
    `Session started ${day(opts.session.createdAt)}.\n\n` +
    (ctx.objective ? `## Objective\n\n${ctx.objective}\n\n` : '') +
    list('decisions', 'Decisions') +
    list('questions', 'Open questions') +
    list('facts', 'Facts') +
    list('constraints', 'Constraints') +
    (links.length
      ? `## Links\n\n` +
        links.map((l) => `- **${l.type}** [${l.title ?? l.url}](${l.url}) — ${l.provider}${l.status ? ` · ${l.status}${l.statusAt ? ` (as of ${day(l.statusAt)})` : ''}` : ''}`).join('\n') +
        '\n\n'
      : '') +
    (outputs.length
      ? `## Documents\n\n` +
        outputs.map((o) => `- **${o.name}** (${o.kind}, v${o.version}) — [${o.mainFile}](<${o.folder}/${o.mainFile}>) · [changes](<${o.folder}/CHANGES.md>)${o.comments.length ? ` · [comments](<${o.folder}/COMMENTS.md>)` : ''}`).join('\n') +
        '\n\n'
      : '') +
    (artifacts.length
      ? `## Artifacts\n\n` + artifacts.map((a) => (a.type === 'link' ? `- [${a.name}](${a.url})` : `- [${a.name}](<${a.path}>)`)).join('\n') + '\n\n'
      : '') +
    `## Timeline\n\n${timeline.length} message${timeline.length === 1 ? '' : 's'} — see [timeline.md](timeline.md).\n\n` +
    (history.length
      ? `## Context history\n\nEvery change to the objective, facts, decisions, questions and constraints, oldest first.\n\n` +
        history.map((h) => `- ${day(h.e.createdAt)} — @${h.who ?? 'a template'} ${h.e.op === 'add' ? 'added' : h.e.op === 'remove' ? 'removed' : 'set'} ${h.e.field === 'objective' ? 'the objective' : `a ${h.e.field.replace(/s$/, '')}`}: ${h.e.value}`).join('\n') +
        '\n'
      : '');

  files.unshift({ path: 'README.md', data: readme });
  files.push({
    path: 'session.json',
    data: JSON.stringify(
      {
        format: 'fabrikka-export/1',
        exportedBy: opts.exportedBy,
        exportedAt,
        session: opts.session,
        context: { objective: ctx.objective, decisions: ctx.decisions, questions: ctx.questions, facts: ctx.facts, constraints: ctx.constraints },
        contextHistory: history.map((h) => ({ at: h.e.createdAt.toISOString(), by: h.who, field: h.e.field, op: h.e.op, value: h.e.value })),
        links,
        outputs,
        artifacts,
        timeline,
      },
      null,
      2,
    ),
  });

  const stamp = exportedAt.slice(0, 10);
  return { filename: `${slug(opts.session.title)} — ${stamp}.zip`, data: zip(files) };
}
