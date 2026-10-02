import {
  applyAnchoredEdits,
  AttributionTracker,
  deltaToSplices,
  lineDiff,
} from '../output-text.ts';

let fails = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('ok  ', label);
  else { console.error('FAIL', label, '\n  got ', g, '\n  want', w); fails++; }
};

/* ------------------------------------------------------------ anchored edits */

const doc = 'Intro.\n\nThe webhook retries three times.\n\nConclusion.\n';

let r = applyAnchoredEdits(doc, [{ old_text: 'three times', new_text: 'five times' }]);
eq('a unique anchor applies', r.ok && r.text.includes('five times'), true);

r = applyAnchoredEdits(doc, [{ old_text: 'four times', new_text: 'x' }]);
eq('a missing anchor is anchor_not_found', !r.ok && r.code, 'anchor_not_found');

r = applyAnchoredEdits(doc, [{ old_text: '.\n', new_text: '!\n' }]);
eq('a repeated anchor is anchor_ambiguous', !r.ok && r.code, 'anchor_ambiguous');

r = applyAnchoredEdits(doc, [
  { old_text: 'Intro.', new_text: 'Introduction.' },
  { old_text: 'missing', new_text: 'x' },
]);
eq('all or none: a later missing anchor applies nothing', r.ok, false);

r = applyAnchoredEdits(doc, [
  { old_text: 'Intro.', new_text: 'Intro. Intro.' },
  { old_text: 'Intro.', new_text: 'x' },
]);
eq('anchors are checked against the text as it stands at that edit', !r.ok && r.code, 'anchor_ambiguous');

r = applyAnchoredEdits(doc, [{ old_text: '', new_text: 'x' }]);
eq('an empty anchor is refused', !r.ok && r.code, 'invalid_edit');

/* ------------------------------------------------------------------ diffs */

const d = lineDiff('a.md', 'one\ntwo\nthree\n', 'one\n2\nthree\nfour\n');
eq('line diff counts added lines', d.added, 2);
eq('line diff counts removed lines', d.removed, 1);

/* ------------------------------------------------------------ attribution */

const type = (t: AttributionTracker, who: string, pos: number, s: string, at = 0) => {
  const out = [];
  for (const [i, ch] of [...s].entries()) out.push(...t.record('f', who, [{ pos: pos + i, deleteCount: 0, insert: ch }], at));
  return out;
};

{
  const t = new AttributionTracker({ f: 'alpha\nbeta\ngamma\n' });
  type(t, 'A', 5, ' one');
  const [row] = t.flushAll();
  eq('typing coalesces into one row', row?.participantId, 'A');
  eq('…and its diff is the changed line', row?.diff.includes('+alpha one'), true);
}

{
  // A types on line 1 while B types on line 3, interleaved keystroke by keystroke.
  const t = new AttributionTracker({ f: 'alpha\nbeta\ngamma\n' });
  const a = ' AAA', b = ' BBB';
  for (let i = 0; i < 4; i++) {
    t.record('f', 'A', [{ pos: 5 + i, deleteCount: 0, insert: a[i]! }]);
    // End of "gamma", pushed right by A's i+1 chars and B's own i.
    t.record('f', 'B', [{ pos: 16 + (i + 1) + i, deleteCount: 0, insert: b[i]! }]);
  }
  eq('interleaved text is right', t.text('f'), 'alpha AAA\nbeta\ngamma BBB\n');
  const rows = t.flushAll();
  const ra = rows.find((x) => x.participantId === 'A')!;
  const rb = rows.find((x) => x.participantId === 'B')!;
  eq("A's diff has A's line", ra.diff.includes('+alpha AAA'), true);
  const changed = (diff: string) =>
    diff.split('\n').filter((l) => /^[+-]/.test(l)).join('\n');
  eq("A's diff does not claim B's line", changed(ra.diff).includes('BBB'), false);
  eq("B's diff has B's line", rb.diff.includes('+gamma BBB'), true);
  eq("B's diff does not claim A's text", changed(rb.diff).includes('AAA'), false);
}

{
  // Backspacing over what you just typed nets out to nothing.
  const t = new AttributionTracker({ f: 'x\n' });
  type(t, 'A', 1, 'yz');
  t.record('f', 'A', [{ pos: 2, deleteCount: 1, insert: '' }]);
  t.record('f', 'A', [{ pos: 1, deleteCount: 1, insert: '' }]);
  eq('typed then deleted: no row', t.flushAll().length, 0);
}

{
  // B edits inside the word A is typing: A's burst closes first, attributed to A.
  const t = new AttributionTracker({ f: 'hello\n' });
  type(t, 'A', 5, ' world');
  const early = t.record('f', 'B', [{ pos: 8, deleteCount: 1, insert: 'R' }]);
  eq("an intrusion closes the other person's burst", early.map((x) => x.participantId), ['A']);
  const rest = t.flushAll();
  eq('…and the intruder gets their own row', rest.map((x) => x.participantId), ['B']);
}

{
  const t = new AttributionTracker({ f: 'a\n' });
  t.record('f', 'A', [{ pos: 1, deleteCount: 0, insert: 'b' }], 1000);
  eq('not idle yet: nothing flushed', t.flushIdle(10_000, 5000).length, 0);
  eq('idle: flushed', t.flushIdle(10_000, 12_000).length, 1);
}

eq(
  'Yjs deltas become running-coordinate splices',
  deltaToSplices([{ retain: 2 }, { delete: 3 }, { insert: 'xy' }, { retain: 1 }, { insert: 'z' }]),
  [
    { pos: 2, deleteCount: 3, insert: '' },
    { pos: 2, deleteCount: 0, insert: 'xy' },
    { pos: 5, deleteCount: 0, insert: 'z' },
  ],
);

/* ------------------------------------------- property: two typists, random */

/**
 * Model the text as tagged characters. For each participant, "the text without
 * their changes" is: every visible char they did NOT insert, plus every char
 * they deleted. The tracker's diff must be exactly before→after for that.
 */
let seed = 7;
const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);

for (let trial = 0; trial < 200; trial++) {
  type Ch = { c: string; by: string; deletedBy: string | null };
  const base = 'line one\nline two\nline three\nline four\n';
  const chars: Ch[] = [...base].map((c) => ({ c, by: 'base', deletedBy: null }));
  const t = new AttributionTracker({ f: base });
  // Each typist owns a separate line so nobody intrudes; that path is tested above.
  const cursors: Record<string, number> = { A: 4, B: 22 };
  const visible = () => chars.filter((x) => !x.deletedBy);
  const idxOf = (pos: number) => {
    let seen = 0;
    for (let i = 0; i < chars.length; i++) {
      if (chars[i]!.deletedBy) continue;
      if (seen === pos) return i;
      seen++;
    }
    return chars.length;
  };

  for (let step = 0; step < 40; step++) {
    const who = rand(2) ? 'A' : 'B';
    const other = who === 'A' ? 'B' : 'A';
    const pos = cursors[who]!;
    if (rand(4) === 0 && pos > 0 && visible()[pos - 1]!.by === who) {
      // Backspace only over your own text, so the typists never collide.
      chars[idxOf(pos - 1)]!.deletedBy = who;
      t.record('f', who, [{ pos: pos - 1, deleteCount: 1, insert: '' }]);
      cursors[who] = pos - 1;
      if (cursors[other]! > pos - 1) cursors[other]!--;
    } else {
      const ch = 'xyz'[rand(3)]!;
      chars.splice(idxOf(pos), 0, { c: ch, by: who, deletedBy: null });
      t.record('f', who, [{ pos, deleteCount: 0, insert: ch }]);
      cursors[who] = pos + 1;
      if (cursors[other]! > pos) cursors[other]!++;
    }
  }

  const after = visible().map((x) => x.c).join('');
  if (t.text('f') !== after) { eq(`trial ${trial}: tracker text`, t.text('f'), after); break; }

  const rows = t.flushAll();
  for (const who of ['A', 'B']) {
    const without = chars
      .filter((x) => (x.by !== who && !x.deletedBy) || (x.by !== who && x.deletedBy === who))
      .map((x) => x.c)
      .join('');
    const want = lineDiff('f', without, after).diff;
    const got = rows.find((x) => x.participantId === who)?.diff ?? '';
    if (got !== want) {
      eq(`trial ${trial}: ${who}'s diff contains only ${who}'s changes`, got, want);
      trial = 1e9;
      break;
    }
  }
}
eq('200 random interleavings: every diff is exactly its author\'s', true, true);

if (fails) {
  console.error(`\n${fails} failure(s)`);
  process.exit(1);
}
