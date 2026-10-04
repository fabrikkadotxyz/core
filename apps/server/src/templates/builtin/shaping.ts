import type { BuiltinTemplate } from '../registry.ts';

/** Shaping: decide what's worth building before anyone builds it. */
export const shaping: BuiltinTemplate = {
  id: 'shaping',
  name: 'Shaping',
  description: 'Shape a pitch before anyone builds: problem, appetite, solution, rabbit holes, no-gos.',
  body: {
    objective: 'Shape a pitch the team can bet on — or decide not to.',
    constraints: ['Appetite: fill in how much time this is worth (e.g. 6 weeks)'],
    questions: ['What exactly is the problem, in one sentence?', 'What would make this not worth doing?'],
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
