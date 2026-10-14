/**
 * One open output. Loaded lazily — see Outputs.tsx.
 *
 * This file is what every kind shares: the title, presence, the tab strip and
 * delete. What goes under the tabs is the kind's body, from its module in
 * `kinds/` (ADR 0023). Nothing here knows which kinds exist.
 */
import { Suspense, useEffect, useRef, useState } from 'react';
import { typingAttrs } from '../typing.ts';
import type { Output, OutputEditSummary, Participant } from '@fabrikka/types';
import { sessions, type SessionRef } from '../api.ts';
import type { OutputTab } from './Outputs.tsx';
import { colorFor, connectOutput, type OutputSync, type SyncStatus } from './sync.ts';
import { webKind } from './kinds/registry.ts';
import { CommentsPanel, selectedQuote } from './Comments.tsx';

/* -------------------------------------------------------------------------- */
/* One open output                                                            */
/* -------------------------------------------------------------------------- */

export default function OutputView({
  ref_,
  output,
  me,
  canDelete,
  tab,
  onTab,
  focusEdit,
  renameOnOpen,
  editsVersion,
  onClose,
  readOnly = false,
  commentsVersion = 0,
}: {
  ref_: SessionRef;
  output: Output;
  me: Participant;
  canDelete: boolean;
  tab: OutputTab;
  onTab: (t: OutputTab) => void;
  /** An edit to show — from "Show me" in the timeline or the notice. */
  focusEdit: OutputEditSummary | null;
  renameOnOpen: boolean;
  /** Bumped whenever an edit to this output is published. */
  editsVersion: number;
  onClose: () => void;
  /** A viewer (M22): the output is shown, not edited. */
  readOnly?: boolean;
  /** Bumped whenever a comment on this output changes (M23). */
  commentsVersion?: number;
}) {
  const [status, setStatus] = useState<SyncStatus>('connecting');
  const [sync, setSync] = useState<OutputSync | null>(null);
  const [people, setPeople] = useState<{ name: string; color: string }[]>([]);

  useEffect(() => {
    const s = connectOutput(ref_, output.id, { name: me.displayName, color: colorFor(me.id) }, setStatus);
    const onAwareness = () => {
      const seen = new Map<string, { name: string; color: string }>();
      for (const [id, st] of s.awareness.getStates()) {
        const u = (st as { user?: { name: string; color: string } }).user;
        if (u && id !== s.doc.clientID) seen.set(u.name, u);
      }
      setPeople([...seen.values()]);
    };
    s.awareness.on('change', onAwareness);
    setSync(s);
    return () => {
      s.awareness.off('change', onAwareness);
      s.destroy();
      setSync(null);
    };
  }, [ref_, output.id, me.displayName, me.id]);

  const kind = webKind(output.kind);
  const tabs: [OutputTab, string][] = [
    ['edit', kind.tabs.edit],
    ...(kind.tabs.preview ? [['preview', kind.tabs.preview] as [OutputTab, string]] : []),
    ['history', 'History'],
    ['comments', 'Comments'],
  ];
  const Body = kind.Body;

  // M23: select a passage anywhere in the view, then comment on it.
  const viewRef = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState<{ quote: string; body: string } | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);
  const startComment = () => {
    setCommentError(null);
    const quote = selectedQuote(viewRef.current);
    if (!quote) {
      setCommentError('Select the passage you want to comment on first.');
      return;
    }
    setDraft({ quote, body: '' });
  };
  const postComment = async () => {
    if (!draft?.body.trim()) return;
    try {
      await sessions.addComment(ref_, output.id, { quote: draft.quote, body: draft.body.trim() });
      setDraft(null);
      onTab('comments');
    } catch (err) {
      setCommentError((err as Error).message);
    }
  };

  return (
    <section ref={viewRef} className="output-view" aria-label={`Document: ${output.name}`}>
      <header className="output-head">
        <button className="link back" onClick={onClose} title="Back to all documents">
          ← Documents
        </button>
        <span className="spacer" />
        <Presence people={people} />
        {canDelete && (
          <button
            className="link danger small"
            onClick={async () => {
              if (!window.confirm(`Delete "${output.name}" for everyone in this session?`)) return;
              await sessions.deleteOutput(ref_, output.id);
              onClose();
            }}
          >
            Delete
          </button>
        )}
      </header>

      {readOnly ? (
        <h2 className="output-title">{output.name}</h2>
      ) : (
        <TitleField ref_={ref_} output={output} autoFocus={renameOnOpen} />
      )}

      <div className="tabs" role="tablist">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'tab on' : 'tab'}
            onClick={() => onTab(key)}
          >
            {label}
          </button>
        ))}
        <span className="spacer" />
        <button
          className="link small"
          // Keep the selection: a mousedown would clear it before the click lands.
          onMouseDown={(e) => e.preventDefault()}
          onClick={startComment}
          title="Select a passage first"
        >
          Comment on selection
        </button>
        {readOnly ? <span className="sync-badge">View only</span> : <SyncBadge status={status} />}
      </div>

      {(draft || commentError) && (
        <div className="comment-draft">
          {draft && (
            <>
              <blockquote>{draft.quote}</blockquote>
              <textarea
                autoFocus
                value={draft.body}
                placeholder="Your comment…"
                aria-label="Comment"
                {...typingAttrs()}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              />
              <div className="row">
                <button onClick={postComment} disabled={!draft.body.trim()}>
                  Comment
                </button>
                <button className="link" onClick={() => setDraft(null)}>
                  Cancel
                </button>
              </div>
            </>
          )}
          {commentError && <p className="error small">{commentError}</p>}
        </div>
      )}

      {tab === 'comments' && (
        <CommentsPanel ref_={ref_} outputId={output.id} version={commentsVersion} isMember={!readOnly} myName={me.displayName} />
      )}

      {sync && (
        <Suspense fallback={<p className="muted small editor-loading">{kind.loading ?? 'Opening…'}</p>}>
          <Body
            ref_={ref_}
            output={output}
            sync={sync}
            tab={tab}
            onTab={onTab}
            focusEdit={focusEdit}
            editsVersion={editsVersion}
            readOnly={readOnly}
          />
        </Suspense>
      )}
    </section>
  );
}

function TitleField({ ref_, output, autoFocus }: { ref_: SessionRef; output: Output; autoFocus: boolean }) {
  const [name, setName] = useState(output.name);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setName(output.name), [output.name]);
  useEffect(() => {
    if (autoFocus) input.current?.select();
  }, [autoFocus]);

  const save = () => {
    const next = name.trim();
    if (!next) return setName(output.name);
    if (next !== output.name) void sessions.renameOutput(ref_, output.id, next);
  };

  return (
    <input
      ref={input}
      className="output-title"
      value={name}
      aria-label="Document name"
      onChange={(e) => setName(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setName(output.name);
          setTimeout(() => input.current?.blur());
        }
      }}
    />
  );
}

function Presence({ people }: { people: { name: string; color: string }[] }) {
  if (people.length === 0) return <span className="muted small">Only you here</span>;
  return (
    <span className="presence" title={`Also here: ${people.map((p) => p.name).join(', ')}`}>
      {people.slice(0, 5).map((p) => (
        <span key={p.name} className="avatar" style={{ background: p.color }}>
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {people.length > 5 && <span className="muted small">+{people.length - 5}</span>}
    </span>
  );
}

function SyncBadge({ status }: { status: SyncStatus }) {
  const label = {
    connecting: 'Connecting…',
    synced: 'Live',
    offline: 'Reconnecting…',
    refused: 'Unavailable',
  }[status];
  return (
    <span className={`sync-badge ${status}`} title="Changes are saved and shared as you type">
      {label}
    </span>
  );
}
