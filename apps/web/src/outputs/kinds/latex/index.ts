import { lazy } from 'react';
import type { WebKind } from '../types.ts';

/** A LaTeX paper. The TeX engine and PDF renderer are large; only papers pay for them. */
export const latex: WebKind = {
  tabs: { edit: 'Source', preview: 'PDF' },
  // "Show me" on a paper means the page it changed.
  showEditIn: 'preview',
  loading: 'Loading the LaTeX tools…',
  Body: lazy(() => import('./LatexBody.tsx')),
};
