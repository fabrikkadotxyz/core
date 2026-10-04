/**
 * Session links: pointers to things outside the session — tickets, PRs, repos,
 * docs, dashboards, errors. See docs/protocol.md (M19).
 *
 * A link is never a copy: the vendor is the source of truth, and `status` is
 * exactly as fresh as whoever last reported it. Linking is an upsert keyed by
 * URL, so adding can never delete anything; removal is explicit (ADR 0013's rule).
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import { participants, sessionLinks } from '@fabrikka/db';
import { LINK_TYPES, type LinkType, type SessionLink } from '@fabrikka/types';
import { publish } from './bus.ts';

const MAX_URL = 2000;
const MAX_TITLE = 200;
const MAX_STATUS = 60;
const MAX_PROVIDER = 40;

export class LinkError extends Error {}

export interface LinkInput {
  url: string;
  type: string;
  title?: string;
  status?: string;
  provider?: string;
}

/** Only http(s): a `javascript:` URL rendered as a link is an XSS. */
function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new LinkError('url must be an absolute http or https URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new LinkError('url must be an absolute http or https URL');
  }
  if (url.href.length > MAX_URL) throw new LinkError(`url is longer than ${MAX_URL} characters`);
  return url;
}

function clean(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().slice(0, max);
  return v || undefined;
}

export async function listLinks(db: Database, sessionId: string, type?: string): Promise<SessionLink[]> {
  const rows = await db
    .select({ l: sessionLinks, addedBy: participants.displayName })
    .from(sessionLinks)
    .leftJoin(participants, eq(participants.id, sessionLinks.addedByParticipantId))
    .where(and(eq(sessionLinks.sessionId, sessionId), type ? eq(sessionLinks.type, type) : undefined))
    .orderBy(asc(sessionLinks.createdAt));
  return rows.map(({ l, addedBy }) => ({
    type: l.type as LinkType,
    provider: l.provider,
    url: l.url,
    title: l.title,
    status: l.status,
    statusAt: l.statusAt?.toISOString() ?? null,
    addedBy,
    updatedAt: l.updatedAt.toISOString(),
  }));
}

/** Add a link, or update the one with this URL. Fields left out keep their value. */
export async function saveLink(
  db: Database,
  opts: { sessionId: string; participantId: string; input: LinkInput },
): Promise<SessionLink> {
  const url = parseUrl(opts.input.url);
  if (!(LINK_TYPES as readonly string[]).includes(opts.input.type)) {
    throw new LinkError(`type must be one of: ${LINK_TYPES.join(', ')}`);
  }
  const title = clean(opts.input.title, MAX_TITLE);
  const status = clean(opts.input.status, MAX_STATUS);
  const provider = clean(opts.input.provider, MAX_PROVIDER);
  const now = new Date();

  await db
    .insert(sessionLinks)
    .values({
      sessionId: opts.sessionId,
      type: opts.input.type,
      provider: provider ?? url.hostname,
      url: url.href,
      title: title ?? null,
      status: status ?? null,
      statusAt: status ? now : null,
      addedByParticipantId: opts.participantId,
    })
    .onConflictDoUpdate({
      target: [sessionLinks.sessionId, sessionLinks.url],
      set: {
        type: opts.input.type,
        updatedAt: now,
        ...(provider ? { provider } : {}),
        ...(title ? { title } : {}),
        ...(status ? { status, statusAt: now } : {}),
      },
    });

  repoCache.delete(opts.sessionId);
  publish(opts.sessionId, { type: 'links.changed' });
  const saved = (await listLinks(db, opts.sessionId)).find((l) => l.url === url.href);
  return saved!;
}

export async function removeLink(db: Database, sessionId: string, rawUrl: string): Promise<boolean> {
  const url = parseUrl(rawUrl);
  const done = await db
    .delete(sessionLinks)
    .where(and(eq(sessionLinks.sessionId, sessionId), eq(sessionLinks.url, url.href)))
    .returning({ id: sessionLinks.id });
  if (done.length) {
    repoCache.delete(sessionId);
    publish(sessionId, { type: 'links.changed' });
  }
  return done.length > 0;
}

type Repo = { url: string; title: string | null };

/**
 * Linked repos per session, cached so mention delivery stays synchronous: a
 * database round trip in front of every mention is latency on the hottest path.
 * Dropped on every change to a session's links. In-process, like the bus.
 */
const repoCache = new Map<string, Repo[]>();

/** The cached repos, or undefined when they have to be loaded first. */
export function cachedRepos(sessionId: string): Repo[] | undefined {
  return repoCache.get(sessionId);
}

/** The repos a session is about, for a spawned run's preamble. */
export async function linkedRepos(db: Database, sessionId: string): Promise<Repo[]> {
  const cached = repoCache.get(sessionId);
  if (cached) return cached;
  const repos = await db
    .select({ url: sessionLinks.url, title: sessionLinks.title })
    .from(sessionLinks)
    .where(and(eq(sessionLinks.sessionId, sessionId), eq(sessionLinks.type, 'repo')))
    .orderBy(asc(sessionLinks.createdAt))
    .limit(20);
  repoCache.set(sessionId, repos);
  return repos;
}

