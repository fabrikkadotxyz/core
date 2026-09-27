/**
 * Mention resolution.
 *
 * Canonical storage is message text containing `<@participant_id>` markers, with
 * `message_mentions` rows DERIVED from those markers. One source of truth, so
 * content and rows cannot drift apart.
 *
 * See docs/decisions/0008-mentions-as-stable-markers.md.
 */
import type { Participant } from '@fabrikka/types';

/** The stored marker syntax. Part of the data format — see docs/protocol.md. */
const MARKER = /<@([0-9a-f-]{36})>/gi;

/**
 * A bare `@handle` in prose.
 *
 * The lookbehind is what stops `fede@example.com` becoming a mention: an `@`
 * preceded by a word character is part of a larger token (an email address, a
 * package spec like `pkg@1.2.0`), not the start of a handle.
 *
 * The character class matches what we actually generate for display names — see
 * freeDisplayName in sessions.ts — letters, digits, hyphen, underscore, dot.
 */
const BARE_HANDLE = /(?<![A-Za-z0-9._-])@([A-Za-z0-9._-]+)/g;

/** Trailing sentence punctuation that the handle class swallows. */
const TRAILING_PUNCT = /[._-]+$/;

export interface ResolveInput {
  /** Text as written, which may already contain markers. */
  content: string;
  /** Explicit participant ids from a composer that resolved them by autocomplete. */
  mentions?: string[];
  /** Every participant in the target session. */
  participants: Participant[];
}

export type ResolveResult =
  | { ok: true; content: string; mentionedParticipantIds: string[] }
  | { ok: false; error: string };

/**
 * Turn written text into canonical stored form.
 *
 * 1. Replace each explicitly-mentioned participant's current `@display_name`
 *    with its marker — this serves the web composer, which knows ids.
 * 2. Convert remaining bare `@name` tokens by exact match, longest first —
 *    this serves agents posting prose over MCP, which do not know ids.
 * 3. Derive the mention list from the markers now present.
 *
 * An explicit id whose name never appears in the text still yields a mention:
 * that is a deliberate mention with no inline text, which agents want.
 */
export function resolveMentions(input: ResolveInput): ResolveResult {
  const byId = new Map(input.participants.map((p) => [p.id, p]));

  // A foreign participant id is refused, never dropped. Dropping it would make a
  // cross-session reference look like it succeeded. See docs/security.md.
  for (const id of input.mentions ?? []) {
    if (!byId.has(id)) {
      return { ok: false, error: `unknown participant in mentions: ${id}` };
    }
  }

  // Markers already present in the input are held to the same rule.
  for (const [, id] of input.content.matchAll(MARKER)) {
    if (!byId.has(id!.toLowerCase())) {
      return { ok: false, error: `unknown participant in content: ${id}` };
    }
  }

  let content = input.content;

  // Step 1 — explicit ids, first occurrence of each name.
  for (const id of input.mentions ?? []) {
    const participant = byId.get(id)!;
    const needle = `@${participant.displayName}`;
    const at = content.indexOf(needle);
    if (at !== -1) {
      content =
        content.slice(0, at) + `<@${id}>` + content.slice(at + needle.length);
    }
  }

  // Step 2 — bare handles. Longest name first so `@claude-fede` is not
  // shadowed by a participant called `claude`.
  const byName = [...input.participants].sort(
    (a, b) => b.displayName.length - a.displayName.length,
  );

  content = content.replace(BARE_HANDLE, (match, handle: string) => {
    const exact = byName.find((p) => handle === p.displayName);
    if (exact) return `<@${exact.id}>`;

    // `@fede.` at the end of a sentence: the class swallowed the period, so
    // retry against the handle with trailing punctuation removed. Deliberately
    // NOT a general prefix match — that would turn `@example.com` into a
    // mention of a participant unluckily named `e`.
    const trimmed = handle.replace(TRAILING_PUNCT, '');
    if (trimmed !== handle) {
      const hit = byName.find((p) => trimmed === p.displayName);
      if (hit) return `<@${hit.id}>` + handle.slice(trimmed.length);
    }
    return match;
  });

  // Step 3 — derive from the canonical content, then union the explicit ids.
  const fromMarkers = new Set(
    [...content.matchAll(MARKER)].map(([, id]) => id!.toLowerCase()),
  );
  for (const id of input.mentions ?? []) fromMarkers.add(id);

  return { ok: true, content, mentionedParticipantIds: [...fromMarkers] };
}

/**
 * Expand markers to `@display_name`.
 *
 * Used by the MCP projection, because an agent should receive readable prose
 * rather than internal ids. The web client keeps the markers and renders chips.
 */
export function renderMentions(
  content: string,
  participants: Pick<Participant, 'id' | 'displayName'>[],
): string {
  const byId = new Map(participants.map((p) => [p.id, p.displayName]));
  return content.replace(MARKER, (match, id: string) => {
    const name = byId.get(id.toLowerCase());
    return name ? `@${name}` : match;
  });
}

/** Participant ids referenced by markers in `content`. */
export function markersIn(content: string): string[] {
  return [...content.matchAll(MARKER)].map(([, id]) => id!.toLowerCase());
}
