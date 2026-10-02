/**
 * The text half of outputs: anchored edits and attribution. Pure — no Yjs, no
 * database — so the parts that decide what an edit means are unit-tested.
 *
 * See ADR 0019.
 */
import { structuredPatch } from 'diff';

/* -------------------------------------------------------------------------- */
/* Anchored edits                                                             */
/* -------------------------------------------------------------------------- */

export interface AnchoredEdit {
  old_text: string;
  new_text: string;
}

/** One primitive change, in the coordinates of the text it applies to. */
export interface Splice {
  pos: number;
  deleteCount: number;
  insert: string;
}

export type EditCode = 'anchor_not_found' | 'anchor_ambiguous' | 'invalid_edit';

export type ApplyResult =
  | { ok: true; text: string; splices: Splice[] }
  | { ok: false; code: EditCode; message: string };

/**
 * Apply `{ old_text, new_text }` pairs in order, all or none.
 *
 * Each anchor must occur exactly once in the text as it stands when that edit
 * is reached. The anchor IS the conflict check: a human typing elsewhere does not
 * invalidate it, a human rewriting the quoted sentence does.
 */
export function applyAnchoredEdits(text: string, edits: AnchoredEdit[]): ApplyResult {
  if (edits.length === 0) {
    return { ok: false, code: 'invalid_edit', message: 'edits is empty' };
  }

  let current = text;
  const splices: Splice[] = [];

  for (const [i, edit] of edits.entries()) {
    const n = `edit ${i + 1} of ${edits.length}`;
    if (!edit.old_text) {
      return {
        ok: false,
        code: 'invalid_edit',
        message: `${n}: old_text is empty — use append to add text at the end`,
      };
    }
    const at = current.indexOf(edit.old_text);
    if (at === -1) {
      return {
        ok: false,
        code: 'anchor_not_found',
        message:
          `${n}: old_text is not in the file — someone may have changed it. ` +
          'Re-read and retry against the current text. Nothing was applied.',
      };
    }
    if (current.indexOf(edit.old_text, at + 1) !== -1) {
      return {
        ok: false,
        code: 'anchor_ambiguous',
        message:
          `${n}: old_text occurs more than once — quote more surrounding text. ` +
          'Nothing was applied.',
      };
    }
    splices.push({ pos: at, deleteCount: edit.old_text.length, insert: edit.new_text });
    current = current.slice(0, at) + edit.new_text + current.slice(at + edit.old_text.length);
  }

  return { ok: true, text: current, splices };
}

/* -------------------------------------------------------------------------- */
/* Diffs                                                                      */
/* -------------------------------------------------------------------------- */

export interface LineDiff {
  diff: string;
  added: number;
  removed: number;
}

export function lineDiff(file: string, before: string, after: string): LineDiff {
  const patch = structuredPatch(file, file, before, after, '', '', { context: 2 });
  let added = 0;
  let removed = 0;
  const out: string[] = [];
  for (const h of patch.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const line of h.lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
      // jsdiff marks a missing final newline with a "\" line; it is noise here.
      if (!line.startsWith('\\')) out.push(line);
    }
  }
  return { diff: out.join('\n'), added, removed };
}

/* -------------------------------------------------------------------------- */
/* Attribution                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One participant's contiguous change, in CURRENT text coordinates: the range
 * [pos, pos + ins.length) holds `ins`, which replaced `del`.
 */
interface Op {
  pos: number;
  del: string;
  ins: string;
}

interface Burst {
  participantId: string;
  file: string;
  ops: Op[];
  lastAt: number;
}

export interface FlushedBurst extends LineDiff {
  participantId: string;
  file: string;
}

/**
 * Coalesces typing into attributed edits, exactly, while several people type.
 *
 * A burst is one participant's changes to one file since they were last idle.
 * Ops are kept in current-text coordinates and shifted by everyone else's
 * changes, so when a burst closes its diff contains ONLY that participant's
 * changes: the "before" side is today's text with their ops undone, and other
 * people's concurrent typing is identical on both sides.
 *
 * When someone edits inside another person's open op (two people in the same
 * word), that op's burst is closed first rather than guessing who wrote what.
 */
export class AttributionTracker {
  private texts = new Map<string, string>();
  private bursts = new Map<string, Burst>();

  constructor(initial: Record<string, string> = {}) {
    for (const [file, text] of Object.entries(initial)) this.texts.set(file, text);
  }

  text(file: string): string {
    return this.texts.get(file) ?? '';
  }

  /** Record splices made by `participantId`, in order. Returns bursts closed early. */
  record(
    file: string,
    participantId: string,
    splices: Splice[],
    now = Date.now(),
  ): FlushedBurst[] {
    const flushed: FlushedBurst[] = [];
    let cur = this.text(file);

    for (const s of splices) {
      if (s.deleteCount === 0 && s.insert === '') continue;
      const end = s.pos + s.deleteCount;

      // Someone else's open op that this splice reaches INTO: close it first.
      for (const b of this.burstsFor(file)) {
        if (b.participantId === participantId) continue;
        if (b.ops.some((o) => intrudes(o, s.pos, end))) {
          flushed.push(this.finish(b, cur));
        }
      }

      const key = `${participantId}\u0000${file}`;
      let mine = this.bursts.get(key);
      const touching = mine?.ops.filter((o) => touches(o, s.pos, end)) ?? [];
      if (mine && touching.length > 1) {
        // A selection spanning two of my own ops: start clean rather than merge.
        flushed.push(this.finish(mine, cur));
        mine = undefined;
      }
      // The one op of mine this splice extends, if any.
      const o = mine && touching.length === 1 ? touching[0]! : null;

      // Every other op wholly after the change moves with it. Ops it reached
      // into were closed above, so nothing else can overlap it.
      const shift = s.insert.length - s.deleteCount;
      for (const b of this.burstsFor(file)) {
        for (const other of b.ops) {
          if (other !== o && other.pos >= end) other.pos += shift;
        }
      }

      const deleted = cur.slice(s.pos, end);
      const next = cur.slice(0, s.pos) + s.insert + cur.slice(end);

      if (!mine) {
        mine = { participantId, file, ops: [], lastAt: now };
        this.bursts.set(key, mine);
      }

      if (o) {
        // Merge: the union of my op and this splice, as one replacement.
        const start = Math.min(o.pos, s.pos);
        const stop = Math.max(o.pos + o.ins.length, end);
        const before = cur.slice(start, o.pos) + o.del + cur.slice(o.pos + o.ins.length, stop);
        o.pos = start;
        o.del = before;
        o.ins = cur.slice(start, s.pos) + s.insert + cur.slice(end, stop);
        if (o.del === o.ins) mine.ops.splice(mine.ops.indexOf(o), 1);
      } else {
        mine.ops.push({ pos: s.pos, del: deleted, ins: s.insert });
      }
      mine.lastAt = now;
      cur = next;
    }

    this.texts.set(file, cur);
    return flushed.filter((f) => f.diff !== '');
  }

  /** Close one participant's bursts now — an agent's edit is one row per call. */
  flushParticipant(participantId: string): FlushedBurst[] {
    return this.flushWhere((b) => b.participantId === participantId);
  }

  /** Close bursts idle for at least `idleMs`. */
  flushIdle(idleMs: number, now = Date.now()): FlushedBurst[] {
    return this.flushWhere((b) => now - b.lastAt >= idleMs);
  }

  flushAll(): FlushedBurst[] {
    return this.flushWhere(() => true);
  }

  private flushWhere(pred: (b: Burst) => boolean): FlushedBurst[] {
    const out: FlushedBurst[] = [];
    for (const b of [...this.bursts.values()]) {
      if (pred(b)) out.push(this.finish(b, this.text(b.file)));
    }
    return out.filter((f) => f.diff !== '');
  }

  private burstsFor(file: string): Burst[] {
    return [...this.bursts.values()].filter((b) => b.file === file);
  }

  private finish(b: Burst, cur: string): FlushedBurst {
    this.bursts.delete(`${b.participantId}\u0000${b.file}`);
    // Undo this participant's ops, right to left, to get the text as it would be
    // without them. Everyone else's changes are on both sides of the diff.
    let before = cur;
    for (const o of [...b.ops].sort((x, y) => y.pos - x.pos)) {
      before = before.slice(0, o.pos) + o.del + before.slice(o.pos + o.ins.length);
    }
    return { participantId: b.participantId, file: b.file, ...lineDiff(b.file, before, cur) };
  }
}

/** The splice's range touches or overlaps the op's range (adjacency counts). */
function touches(o: Op, start: number, end: number): boolean {
  return start <= o.pos + o.ins.length && end >= o.pos;
}

/** The splice reaches strictly inside the op — not just its edges. */
function intrudes(o: Op, start: number, end: number): boolean {
  const oEnd = o.pos + o.ins.length;
  if (start === end) return start > o.pos && start < oEnd;
  return start < oEnd && end > o.pos;
}

/** Convert a Yjs text delta into splices in running coordinates. */
export function deltaToSplices(
  delta: { retain?: number; insert?: unknown; delete?: number }[],
): Splice[] {
  const out: Splice[] = [];
  let pos = 0;
  for (const d of delta) {
    if (d.retain) pos += d.retain;
    else if (d.delete) out.push({ pos, deleteCount: d.delete, insert: '' });
    else if (typeof d.insert === 'string') {
      out.push({ pos, deleteCount: 0, insert: d.insert });
      pos += d.insert.length;
    }
  }
  return out;
}

export function countLines(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length;
}
