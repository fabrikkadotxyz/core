/**
 * Comments on an output (M23): review as a conversation about a passage.
 *
 * Every thread quotes what it's about. When that passage is rewritten the thread
 * says "outdated" and keeps the quote, so nobody has to guess where it went.
 * Resolved threads collapse; they never disappear. Viewers and guests comment
 * too — commenting is the one thing they can write (M22).
 */
import { useCallback, useEffect, useState } from 'react';
import type { OutputComment } from '@fabrikka/types';
import { sessions, type SessionRef } from '../api.ts';
import { timeAgo } from './Outputs.tsx';

export function CommentsPanel({
  ref_,
  outputId,
  version,
  isMember,
  myName,
}: {
  ref_: SessionRef;
  outputId: string;
  /** Bumped when a comment on this output changes. */
  version: number;
  /** Members resolve any thread; a viewer only threads they started. */
  isMember: boolean;
  myName: string;
}) {
  const [threads, setThreads] = useState<OutputComment[] | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    sessions.comments(ref_, outputId).then(setThreads).catch(() => setThreads([]));
  }, [ref_, outputId]);
  useEffect(load, [load, version]);

  if (!threads) return <p className="muted small">Loading comments…</p>;
  const open = threads.filter((t) => t.status === 'open');
  const resolved = threads.filter((t) => t.status === 'resolved');

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="comments">
      {threads.length === 0 && (
        <p className="muted small">
          No comments yet. Select a passage, then <strong>Comment on selection</strong>.
        </p>
      )}
      {open.map((t) => (
        <Thread key={t.id} t={t} ref_={ref_} outputId={outputId} canResolve={isMember || t.author === myName} act={act} />
      ))}
      {resolved.length > 0 && (
        <>
          <button className="link small" onClick={() => setShowResolved((v) => !v)}>
            {showResolved ? 'Hide' : 'Show'} resolved ({resolved.length})
          </button>
          {showResolved &&
            resolved.map((t) => (
              <Thread key={t.id} t={t} ref_={ref_} outputId={outputId} canResolve={isMember || t.author === myName} act={act} />
            ))}
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function Thread({
  t,
  ref_,
  outputId,
  canResolve,
  act,
}: {
  t: OutputComment;
  ref_: SessionRef;
  outputId: string;
  canResolve: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [reply, setReply] = useState('');
  return (
    <article className={`comment-thread ${t.status}`}>
      <blockquote className={t.outdated ? 'outdated' : ''}>{t.quote}</blockquote>
      <div className="comment-badges">
        {t.outdated && t.status === 'open' && (
          <span className="badge" title="This passage has been rewritten since the comment was made">
            outdated
          </span>
        )}
        {t.status === 'resolved' && (
          <span className="badge">
            resolved{t.resolvedBy ? ` by @${t.resolvedBy}` : ''}
            {t.resolvedAtVersion !== null ? ` in v${t.resolvedAtVersion}` : ''}
          </span>
        )}
      </div>
      <p>
        <strong>@{t.author}</strong> <span className="muted small">{timeAgo(t.createdAt)}</span>
        <br />
        {t.body}
      </p>
      {t.replies.map((r) => (
        <p key={r.id} className="comment-reply">
          <strong>@{r.author}</strong> <span className="muted small">{timeAgo(r.createdAt)}</span>
          <br />
          {r.body}
        </p>
      ))}
      <div className="comment-actions">
        <input
          value={reply}
          placeholder="Reply…"
          aria-label="Reply"
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && reply.trim()) {
              void act(() => sessions.replyComment(ref_, outputId, t.id, reply.trim())).then(() => setReply(''));
            }
          }}
        />
        {canResolve && (
          <button
            className="link small"
            onClick={() => act(() => sessions.setCommentResolved(ref_, outputId, t.id, t.status === 'open'))}
          >
            {t.status === 'open' ? 'Resolve' : 'Reopen'}
          </button>
        )}
      </div>
    </article>
  );
}

/** The text selected inside an output's view, if any — the quote for a new comment. */
export function selectedQuote(root: HTMLElement | null): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !root) return '';
  const node = sel.anchorNode;
  if (!node || !root.contains(node)) return '';
  return sel.toString().trim();
}
