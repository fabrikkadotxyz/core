/**
 * `doc`: a native Markdown document. No account, no setup. See ADR 0019.
 */
import type { OutputKindModule } from '../../contract.ts';
import { yjsStore } from '../../yjs-store.ts';

export const doc: OutputKindModule = {
  id: 'doc',
  name: 'Document',
  description: 'Write together in real time. Headings, lists, links — Markdown underneath.',
  icon: '📝',
  defaultName: 'Untitled document',
  format: 'markdown',
  multiFile: false,
  mainFile: 'document.md',
  available: () => true,
  store: yjsStore,
  // Empty: the name is the title, and a heading copied from it would go stale
  // the first time someone renamed the document.
  template: () => ({ 'document.md': '' }),
};
