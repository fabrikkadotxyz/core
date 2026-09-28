/**
 * Session artifacts: files and links.
 *
 * Files are stored by the SHA-256 of their content, not their name. Two
 * participants uploading `notes.md` get two rows sharing one blob and neither
 * overwrites the other — a filename collision becomes a non-event rather than
 * silent data loss. See ADR 0013.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { artifacts, participants } from '@fabrikka/db';
import type { Artifact } from '@fabrikka/types';

/** A self-hoster should not have to configure object storage to attach a CSV. */
const STORAGE_DIR = process.env.ARTIFACT_DIR ?? join(process.cwd(), '..', '..', '.artifacts');

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

export type ArtifactResult =
  | { ok: true; artifact: Artifact }
  | { ok: false; error: string };

/** Sharded two levels so a directory never holds a hundred thousand entries. */
function blobPath(hash: string): string {
  return join(STORAGE_DIR, hash.slice(0, 2), hash.slice(2, 4), hash);
}

export async function createFileArtifact(
  db: Database,
  opts: {
    sessionId: string;
    participantId: string;
    name: string;
    contentType?: string | null;
    content: Buffer;
  },
): Promise<ArtifactResult> {
  const name = opts.name.trim();
  if (!name) return { ok: false, error: 'a name is required' };
  if (opts.content.byteLength === 0) return { ok: false, error: 'the file is empty' };
  if (opts.content.byteLength > MAX_ARTIFACT_BYTES) {
    return {
      ok: false,
      error: `files are limited to ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB`,
    };
  }

  const hash = createHash('sha256').update(opts.content).digest('hex');
  const path = blobPath(hash);

  // Identical content is already on disk; writing again would be a no-op with a
  // chance of a torn write.
  if (!existsSync(path)) {
    await mkdir(join(STORAGE_DIR, hash.slice(0, 2), hash.slice(2, 4)), {
      recursive: true,
    });
    await writeFile(path, opts.content, { mode: 0o600 });
  }

  const [row] = await db
    .insert(artifacts)
    .values({
      sessionId: opts.sessionId,
      type: 'file',
      name,
      storageKey: hash,
      contentType: opts.contentType ?? null,
      sizeBytes: opts.content.byteLength,
      createdByParticipantId: opts.participantId,
    })
    .returning();

  return { ok: true, artifact: await hydrate(db, row!) };
}

export async function createLinkArtifact(
  db: Database,
  opts: { sessionId: string; participantId: string; name: string; url: string },
): Promise<ArtifactResult> {
  const url = opts.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'a link must be an http(s) URL' };
  }

  const [row] = await db
    .insert(artifacts)
    .values({
      sessionId: opts.sessionId,
      type: 'link',
      name: opts.name.trim() || url,
      storageKey: url,
      createdByParticipantId: opts.participantId,
    })
    .returning();

  return { ok: true, artifact: await hydrate(db, row!) };
}

export async function listArtifacts(
  db: Database,
  sessionId: string,
): Promise<Artifact[]> {
  const rows = await db
    .select({
      a: artifacts,
      authorName: participants.displayName,
    })
    .from(artifacts)
    .innerJoin(participants, eq(participants.id, artifacts.createdByParticipantId))
    .where(eq(artifacts.sessionId, sessionId))
    .orderBy(desc(artifacts.createdAt));

  return rows.map((r) => toArtifact(r.a, r.authorName));
}

/**
 * Read an artifact's bytes.
 *
 * Scoped by session as well as id, so an artifact id from one session cannot be
 * read through another — ids are opaque but must not be a capability.
 */
export async function readArtifact(
  db: Database,
  sessionId: string,
  artifactId: string,
): Promise<{ artifact: Artifact; content: Buffer } | null> {
  const [row] = await db
    .select({ a: artifacts, authorName: participants.displayName })
    .from(artifacts)
    .innerJoin(participants, eq(participants.id, artifacts.createdByParticipantId))
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.sessionId, sessionId)))
    .limit(1);

  if (!row || row.a.type !== 'file') return null;

  const content = await readFile(blobPath(row.a.storageKey)).catch(() => null);
  if (!content) return null;

  return { artifact: toArtifact(row.a, row.authorName), content };
}

export async function deleteArtifact(
  db: Database,
  sessionId: string,
  artifactId: string,
): Promise<boolean> {
  // The blob is deliberately left on disk: another artifact may share it, and at
  // MVP scale reference counting costs more than the bytes. Said out loud rather
  // than discovered later.
  const deleted = await db
    .delete(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.sessionId, sessionId)))
    .returning({ id: artifacts.id });
  return deleted.length > 0;
}

async function hydrate(
  db: Database,
  row: typeof artifacts.$inferSelect,
): Promise<Artifact> {
  const [p] = await db
    .select({ displayName: participants.displayName })
    .from(participants)
    .where(eq(participants.id, row.createdByParticipantId))
    .limit(1);
  return toArtifact(row, p?.displayName ?? 'unknown');
}

function toArtifact(
  row: typeof artifacts.$inferSelect,
  authorName: string,
): Artifact {
  return {
    id: row.id,
    type: row.type as Artifact['type'],
    name: row.name,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    url: row.type === 'link' ? row.storageKey : null,
    createdBy: {
      participantId: row.createdByParticipantId,
      displayName: authorName,
    },
    createdAt: row.createdAt.toISOString(),
  };
}
