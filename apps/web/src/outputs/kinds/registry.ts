/**
 * The output kinds this client has a module for. Adding a kind is a folder in
 * `kinds/` and one line here (ADR 0023).
 *
 * A kind the server offers but this client has no module for still works: it
 * gets the generic text body, an editor and History. The module makes a kind
 * good, not usable.
 */
import { lazy } from 'react';
import type { WebKind } from './types.ts';
import { doc } from './doc/index.ts';
import { latex } from './latex/index.ts';

const WEB_KINDS: Record<string, WebKind> = { doc, latex };

const generic: WebKind = {
  tabs: { edit: 'Edit', preview: null },
  showEditIn: 'history',
  Body: lazy(() => import('../GenericBody.tsx')),
};

export function webKind(id: string): WebKind {
  return WEB_KINDS[id] ?? generic;
}
