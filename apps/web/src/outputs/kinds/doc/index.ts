import { lazy } from 'react';
import type { WebKind } from '../types.ts';

/** A Markdown document. */
export const doc: WebKind = {
  tabs: { edit: 'Edit', preview: 'Preview' },
  // "Show me" on a document means the diff.
  showEditIn: 'history',
  Body: lazy(() => import('./DocBody.tsx')),
};
