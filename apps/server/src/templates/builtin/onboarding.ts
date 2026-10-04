import type { BuiltinTemplate } from '../registry.ts';

/** Onboarding: a first week of real work, with a patient guide. */
export const onboarding: BuiltinTemplate = {
  id: 'onboarding',
  name: 'Onboarding',
  description: "A new hire's first week: real tickets, the architecture, and an agent to ask anything.",
  body: {
    objective: 'Ship a first real change this week, and understand why the code is shaped the way it is.',
    constraints: ['Ask the session, not a person, first — every answer stays here for the next hire'],
    questions: ['Which three tickets are small enough for week one?'],
    outputs: [
      {
        kind: 'doc',
        name: 'Your first week',
        content:
          '## Read first\n\n\n## Your tickets\n\n\n## Who to ask\n\nAsk the lent agent anything about the codebase — it can read, not change.\n\n## What you learned\n\n',
      },
    ],
    connections: ['code host', 'docs'],
  },
};
