import { resolveMentions, renderMentions, markersIn } from '../mentions.ts';

const P = (id: string, displayName: string, kind: 'human' | 'agent' = 'human') =>
  ({ id, sessionId: 's', kind, displayName }) as any;

const FEDE = P('11111111-1111-1111-1111-111111111111', 'fede');
const ALICE = P('22222222-2222-2222-2222-222222222222', 'alice');
const CLAUDE = P('33333333-3333-3333-3333-333333333333', 'claude-fede', 'agent');
const C = P('44444444-4444-4444-4444-444444444444', 'claude', 'agent');
const participants = [FEDE, ALICE, CLAUDE, C];

let fails = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('ok  ', label);
  else { console.error('FAIL', label, '\n  got ', g, '\n  want', w); fails++; }
};

// bare handle resolution
let r = resolveMentions({ content: 'hey @alice look', participants }) as any;
eq('bare @alice -> marker', r.content, `hey <@${ALICE.id}> look`);
eq('bare @alice -> mention row', r.mentionedParticipantIds, [ALICE.id]);

// longest-match: @claude-fede must not be shadowed by @claude
r = resolveMentions({ content: 'ping @claude-fede now', participants }) as any;
eq('longest name wins', r.content, `ping <@${CLAUDE.id}> now`);

r = resolveMentions({ content: 'ping @claude now', participants }) as any;
eq('shorter name still matches', r.content, `ping <@${C.id}> now`);

// trailing punctuation
r = resolveMentions({ content: 'thanks @alice!', participants }) as any;
eq('trailing ! preserved', r.content, `thanks <@${ALICE.id}>!`);
r = resolveMentions({ content: 'ask @alice, then @fede.', participants }) as any;
eq('comma and period preserved', r.content, `ask <@${ALICE.id}>, then <@${FEDE.id}>.`);

// unknown handle left alone
r = resolveMentions({ content: 'email me @nobody ok', participants }) as any;
eq('unknown handle untouched', r.content, 'email me @nobody ok');
eq('unknown handle -> no mentions', r.mentionedParticipantIds, []);

// explicit ids from composer
r = resolveMentions({ content: 'hi @alice', mentions: [ALICE.id], participants }) as any;
eq('explicit id + name', r.content, `hi <@${ALICE.id}>`);
eq('explicit id -> one row', r.mentionedParticipantIds, [ALICE.id]);

// explicit id whose name is absent -> mention with no inline text
r = resolveMentions({ content: 'no handle here', mentions: [FEDE.id], participants }) as any;
eq('programmatic mention: content unchanged', r.content, 'no handle here');
eq('programmatic mention: row still created', r.mentionedParticipantIds, [FEDE.id]);

// multiple mentions
r = resolveMentions({ content: '@fede and @alice', participants }) as any;
eq('two mentions', r.content, `<@${FEDE.id}> and <@${ALICE.id}>`);
eq('two rows', r.mentionedParticipantIds.sort(), [FEDE.id, ALICE.id].sort());

// repeated mention -> one row
r = resolveMentions({ content: '@alice @alice', participants }) as any;
eq('repeated mention dedupes to one row', r.mentionedParticipantIds, [ALICE.id]);

// markers already in input are accepted
r = resolveMentions({ content: `pre <@${ALICE.id}> post`, participants }) as any;
eq('existing marker preserved', r.content, `pre <@${ALICE.id}> post`);
eq('existing marker -> row', r.mentionedParticipantIds, [ALICE.id]);

// foreign id rejected, not dropped
const foreign = '99999999-9999-9999-9999-999999999999';
r = resolveMentions({ content: 'x', mentions: [foreign], participants }) as any;
eq('foreign id in mentions rejected', r.ok, false);
r = resolveMentions({ content: `x <@${foreign}>`, participants }) as any;
eq('foreign marker in content rejected', r.ok, false);

// email-ish text should not become a mention
r = resolveMentions({ content: 'mail fede@example.com please', participants }) as any;
eq('email local part not mentioned', r.mentionedParticipantIds, []);

// rendering
const rendered = renderMentions(`hey <@${ALICE.id}> look`, participants);
eq('render marker -> name', rendered, 'hey @alice look');
eq('render after rename', renderMentions(`hey <@${ALICE.id}>`, [{ id: ALICE.id, displayName: 'alicia' }]), 'hey @alicia');
eq('render unknown marker left as-is', renderMentions(`x <@${foreign}>`, participants), `x <@${foreign}>`);
eq('markersIn', markersIn(`a <@${FEDE.id}> b <@${ALICE.id}>`), [FEDE.id, ALICE.id]);


/* --- regression cases for the tightened bare-handle rule --- */
const E = P('55555555-5555-5555-5555-555555555555', 'e');
const withE = [...participants, E];
let r2 = resolveMentions({ content: 'mail fede@example.com please', participants: withE }) as any;
eq('email not mentioned even when a participant is named "e"', r2.mentionedParticipantIds, []);
eq('email text untouched', r2.content, 'mail fede@example.com please');
r2 = resolveMentions({ content: 'see @fede. done', participants }) as any;
eq('trailing period still resolves', r2.content, `see <@${FEDE.id}>. done`);
r2 = resolveMentions({ content: 'ping @alice.bob', participants }) as any;
eq('ambiguous @alice.bob left alone', r2.mentionedParticipantIds, []);
r2 = resolveMentions({ content: 'use pkg@1.2.0 now', participants }) as any;
eq('package spec not a mention', r2.mentionedParticipantIds, []);
r2 = resolveMentions({ content: '@fede at line start', participants }) as any;
eq('handle at start of string resolves', r2.content, `<@${FEDE.id}> at line start`);
r2 = resolveMentions({ content: '(@alice)', participants }) as any;
eq('handle in parens resolves', r2.content, `(<@${ALICE.id}>)`);

console.log(fails === 0 ? '\nresolver: PASS' : `\nresolver: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
