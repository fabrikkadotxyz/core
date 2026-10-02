/**
 * Outputs in the right pane: live documents the session writes together.
 * See ADR 0019.
 *
 * Built to be obvious to someone who has never seen Fabrikka: one button to
 * start a document, a familiar formatting toolbar, other people's cursors with
 * their names on them, and a History tab that answers "who changed what".
 *
 * This file is the list. The open document — editor, preview, history — is in
 * OutputView.tsx and loaded on first open, so the session screen does not pay
 * for an editor nobody has opened yet.
 */
import { useEffect, useState } from 'react';
import type { Output, OutputKindInfo } from '@fabrikka/types';
import { sessions, type SessionRef } from '../api.ts';

export const KIND_ICON: Record<string, string> = { doc: '📝', latex: '∑' };

export type OutputTab = 'edit' | 'preview' | 'history';

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/* -------------------------------------------------------------------------- */
/* The list                                                                   */
/* -------------------------------------------------------------------------- */

export function OutputsPanel({
  ref_,
  outputs,
  onOpen,
}: {
  ref_: SessionRef;
  outputs: Output[];
  onOpen: (id: string, opts?: { rename?: boolean }) => void;
}) {
  const [kinds, setKinds] = useState<OutputKindInfo[]>([]);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sessions.outputKinds(ref_).then(setKinds).catch(() => {});
  }, [ref_]);

  const available = kinds.filter((k) => k.available);

  const create = async (kind: OutputKindInfo) => {
    setPicking(false);
    setError(null);
    try {
      const o = await sessions.createOutput(ref_, kind.kind, `Untitled ${kind.name.toLowerCase()}`);
      // Straight into it, with the name ready to type over: no dialog first.
      onOpen(o.id, { rename: true });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // One kind: the button just makes one. Several: a short menu that says what each is.
  const onNew = () => (available.length === 1 ? create(available[0]!) : setPicking((p) => !p));

  return (
    <section className="panel outputs-panel">
      <div className="panel-head">
        <h2>Documents</h2>
        {available.length > 0 && outputs.length > 0 && (
          <button className="new-output" onClick={onNew} aria-expanded={picking}>
            + New
          </button>
        )}
      </div>

      {picking && (
        <ul className="kind-menu" role="menu">
          {available.map((k) => (
            <li key={k.kind}>
              <button role="menuitem" onClick={() => create(k)}>
                <span className="kind-icon">{KIND_ICON[k.kind] ?? '📄'}</span>
                <span>
                  <strong>{k.name}</strong>
                  <span className="muted small">{k.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {outputs.length === 0 ? (
        <div className="outputs-empty">
          <p>
            Write something together — a report, notes, a plan. Everyone here, and
            their agents, can edit it at the same time.
          </p>
          {available.length > 0 && (
            <button className="primary" onClick={onNew}>
              + New document
            </button>
          )}
        </div>
      ) : (
        <ul className="output-list">
          {outputs.map((o) => (
            <li key={o.id}>
              <button className="output-card" onClick={() => onOpen(o.id)}>
                <span className="kind-icon" aria-hidden>
                  {KIND_ICON[o.kind] ?? '📄'}
                </span>
                <span className="output-card-text">
                  <span className="output-name">{o.name}</span>
                  <span className="muted small">
                    {o.lastEdit
                      ? `edited ${timeAgo(o.lastEdit.at)} by @${o.lastEdit.displayName}`
                      : `created by @${o.createdBy.displayName}`}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
