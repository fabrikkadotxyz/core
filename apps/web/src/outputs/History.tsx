/**
 * An output's History: every change, who made it, and exactly what it changed.
 */
import { useEffect, useState } from 'react';
import type { OutputEdit } from '@fabrikka/types';
import { sessions, type SessionRef } from '../api.ts';
import { timeAgo } from './Outputs.tsx';
import { colorFor } from './sync.ts';

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

export function History({
  ref_,
  outputId,
  focusEditId,
  version,
}: {
  ref_: SessionRef;
  outputId: string;
  focusEditId: string | null;
  version: number;
}) {
  const [edits, setEdits] = useState<OutputEdit[] | null>(null);
  const [open, setOpen] = useState<string | null>(focusEditId);

  useEffect(() => {
    sessions.outputChanges(ref_, outputId).then(setEdits).catch(() => setEdits([]));
  }, [ref_, outputId, version]);

  useEffect(() => {
    if (focusEditId) setOpen(focusEditId);
  }, [focusEditId]);

  if (!edits) return <p className="muted small">Loading…</p>;
  if (edits.length === 0) {
    return (
      <p className="muted history-empty">
        No changes yet. Edits by people and agents show up here, each with exactly
        what changed. Typing is grouped after a few seconds' pause.
      </p>
    );
  }

  return (
    <ol className="history">
      {edits.map((e) => (
        <li key={e.id} className={open === e.id ? 'open' : ''}>
          <button className="history-row" onClick={() => setOpen(open === e.id ? null : e.id)}>
            <span className="avatar" style={{ background: colorFor(e.participantId ?? e.displayName) }}>
              {e.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="history-who">
              @{e.displayName}
              {e.participantKind === 'agent' && <span className="badge">agent</span>}
            </span>
            <span className="history-delta">
              <span className="plus">+{e.added}</span> <span className="minus">−{e.removed}</span>
            </span>
            <time className="muted small" dateTime={e.at} title={new Date(e.at).toLocaleString()}>
              {timeAgo(e.at)}
            </time>
          </button>
          {open === e.id && <Diff diff={e.diff} />}
        </li>
      ))}
    </ol>
  );
}

function Diff({ diff }: { diff: string }) {
  return (
    <pre className="diff">
      {diff.split('\n').map((line, i) => (
        <span
          key={i}
          className={
            line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''
          }
        >
          {line.startsWith('@@') ? '⋯' : line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
