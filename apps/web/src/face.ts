/**
 * A face without a picture (M67, ADR 0061): two letters on a colour.
 *
 * Initials: split on spaces; two or more words give the first letter of the
 * first and of the last, one word its first two letters. The colour is one of
 * eight theme tokens, picked by a hash of an id, so it looks random across a
 * room and is the same for everyone, everywhere, whatever the name becomes.
 */

export const FACE_COLORS = 8;

export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '').trim().replace(/^@+/, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  // Array.from walks characters, not UTF-16 halves, so an accent or an emoji stays whole.
  const first = Array.from(words[0]!);
  const letters = words.length >= 2 ? [first[0]!, Array.from(words[words.length - 1]!)[0]!] : first.slice(0, 2);
  return letters.join('').toLocaleUpperCase();
}

/** 1 to FACE_COLORS, stable for an id. */
export function faceColor(seed: string): number {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return (h % FACE_COLORS) + 1;
}
