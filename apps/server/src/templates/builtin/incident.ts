import type { BuiltinTemplate } from '../registry.ts';

/** Incident: work it from the record, so whoever comes next can pick it up. */
export const incident: BuiltinTemplate = {
  id: 'incident',
  name: 'Incident',
  description: 'Work an incident so the next person picks it up from the record, not from scrollback.',
  body: {
    notes: [
      { text: 'Stop the bleeding, find the cause, write down what we decided.', tag: 'goal' },
      { text: 'Customer impact first: mitigate before investigating', tag: 'constraint' },
      { text: 'What is broken, for whom, since when?', tag: 'question' },
    ],
    outputs: [
      {
        kind: 'doc',
        name: 'Incident report',
        content: '## Impact\n\n\n## Timeline\n\n\n## Cause\n\n\n## What we changed\n\n\n## Follow-ups\n\n',
      },
    ],
    connections: ['observability', 'code host', 'issue tracker'],
  },
};
