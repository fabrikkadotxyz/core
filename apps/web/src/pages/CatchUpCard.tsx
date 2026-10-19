/**
 * "Since you were here" (M24): what changed in this session since your last
 * visit, built from the record. Nothing here is generated — every line is a
 * note, edit, link or mention someone actually made.
 */
import type { CatchUp } from '@fabrikka/types';
import { timeAgo } from '../outputs/Outputs.tsx';

export function hasNews(c: CatchUp): boolean {
  if (c.firstVisit) return false;
  return c.notes.length + c.removedNotes.length + c.mentions.length + c.outputs.length + c.links.length > 0 || c.messages > 0;
}

export function CatchUpCard({ c, onDone }: { c: Extract<CatchUp, { firstVisit: false }>; onDone: () => void }) {
  const section = (title: string, items: React.ReactNode[]) =>
    items.length > 0 && (
      <div className="catchup-section">
        <h3>{title}</h3>
        <ul>{items}</ul>
      </div>
    );
  const note = (n: { text: string; tag: string | null; by: string | null }, i: number, muted = false) => (
    <li key={i} className={muted ? 'muted' : undefined}>
      {n.tag && <em className="badge">{n.tag}</em>} {n.text}
      {n.by && <span className="muted small"> — @{n.by}</span>}
    </li>
  );
  return (
    <section className="catchup" aria-label="Since you were here">
      <header>
        <strong>Since you were here</strong> <span className="muted small">{timeAgo(c.since)}</span>
        <span className="spacer" />
        <button className="link small" onClick={onDone}>
          Got it
        </button>
      </header>
      {section('Waiting for you', c.mentions.map((m, i) => <li key={i}><strong>@{m.from}</strong>: {m.text}</li>))}
      {section('Noted', c.notes.map((n, i) => note(n, i)))}
      {section('Removed', c.removedNotes.map((n, i) => note(n, i, true)))}
      {section(
        'Documents',
        c.outputs.map((o) => (
          <li key={o.name}>
            {o.name} {o.isNew && <em className="badge">new</em>}{' '}
            <span className="muted small">— {o.editors.map((e) => `@${e}`).join(', ')}</span>
          </li>
        )),
      )}
      {section(
        'Links',
        c.links.map((l) => (
          <li key={l.url}>
            <a href={l.url} target="_blank" rel="noreferrer noopener">{l.title}</a> → <strong>{l.status}</strong>
          </li>
        )),
      )}
      {c.messages > 0 && (
        <p className="muted small">
          {c.messages} new message{c.messages === 1 ? '' : 's'} in the timeline.
        </p>
      )}
    </section>
  );
}
