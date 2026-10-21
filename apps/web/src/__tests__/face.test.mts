/** Faces without a picture (M67, ADR 0061): the initials and the colour. */
import { faceColor, FACE_COLORS, initialsOf } from '../face.ts';

let fails = 0;
const ok = (label: string, cond: boolean) => {
  if (cond) console.log('ok  ', label);
  else { console.error('FAIL', label); fails++; }
};

ok('TWO WORDS: first letter of first and last name', initialsOf('Daniel Levy') === 'DL');
ok('three words: the first and the last', initialsOf('Ana María López') === 'AL');
ok('ONE WORD: its first two letters', initialsOf('Mei') === 'ME');
ok('an agent: one word, hyphen and all', initialsOf('claude-daniel') === 'CL');
ok('a leading @ is ignored', initialsOf('@codex') === 'CO');
ok('upper case', initialsOf('sofía ramírez') === 'SR');
ok('spaces around and between do not count', initialsOf('  Priya   Natarajan ') === 'PN');
ok('accents stay', initialsOf('Émile Zola') === 'ÉZ');
ok('a one-letter name is one letter', initialsOf('Q') === 'Q');
ok('a character beyond the basic plane stays whole', initialsOf('𝒜da Lovelace') === '𝒜L');
ok('no name: ?', initialsOf('') === '?' && initialsOf(null) === '?' && initialsOf('   ') === '?');

ok('THE COLOUR IS STABLE for an id', faceColor('3f1c-user') === faceColor('3f1c-user'));
const seen = new Set(Array.from({ length: 400 }, (_, i) => faceColor(`user-${i}`)));
ok(`…one of ${FACE_COLORS}, and every one is used`, seen.size === FACE_COLORS && [...seen].every((n) => n >= 1 && n <= FACE_COLORS));

if (fails) process.exit(1);
