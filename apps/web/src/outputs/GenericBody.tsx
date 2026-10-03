/**
 * The body for a kind this client has no module for (ADR 0023): its main file in
 * a plain collaborative editor, and History. Usable, if plain — a server-only
 * kind is never a broken pane.
 */
import { History } from './History.tsx';
import { CollabEditor, useYFile } from './CollabEditor.tsx';
import type { KindBodyProps } from './kinds/types.ts';

export default function GenericBody({ ref_, output, sync, tab, focusEdit, editsVersion }: KindBodyProps) {
  const ytext = useYFile(sync.doc, output.mainFile);
  if (tab === 'history') {
    return <History ref_={ref_} outputId={output.id} focusEditId={focusEdit?.id ?? null} version={editsVersion} />;
  }
  if (!ytext) return <p className="muted small editor-loading">Opening…</p>;
  return <CollabEditor ytext={ytext} awareness={sync.awareness} language={[]} toolbar={[]} keys={[]} placeholder="Start writing…" />;
}
