import type { BuiltinTemplate } from '../registry.ts';

/** Shaping: decide what's worth building before anyone builds it. */
export const shaping: BuiltinTemplate = {
  id: 'shaping',
  name: 'Shaping',
  description: 'Shape a pitch before anyone builds: problem, appetite, solution, rabbit holes, no-gos.',
  body: {
    notes: [
      { text: 'Shape a pitch the team can bet on — or decide not to.', tag: 'goal' },
      { text: 'Appetite: fill in how much time this is worth (e.g. 6 weeks)', tag: 'constraint' },
      { text: 'What exactly is the problem, in one sentence?', tag: 'question' },
      { text: 'What would make this not worth doing?', tag: 'question' },
    ],
    outputs: [
      {
        kind: 'doc',
        name: 'Pitch',
        content:
          '## Problem\n\n\n## Appetite\n\n\n## Solution\n\n\n## Rabbit holes\n\n\n## No-gos\n\n',
      },
    ],
    connections: ['issue tracker', 'docs'],
  },
};
