/**
 * "Since you were here" (M24): what changed in this session since your last
 * visit, built from the record. Nothing here is generated — every line is a
 * decision, question, edit or link someone actually made.
 */
import type { CatchUp } from '@fabrikka/types';
import { timeAgo } from '../outputs/Outputs.tsx';

export function hasNews(c: CatchUp): boolean {
  if (c.firstVisit) return false;
  return (
    c.decisions.length + c.facts.length + c.newQuestions.length + c.answeredQuestions.length + c.mentions.length +
      c.outputs.length + c.links.length >
      0 || c.messages > 0
  );
}

export function CatchUpCard({ c, onDone }: { c: Extract<CatchUp, { firstVisit: false }>; onDone: () => void }) {
  const section = (title: string, items: React.ReactNode[]) =>
    items.length > 0 && (
      <div className="catchup-section">
        <h3>{title}</h3>
        <ul>{items}</ul>
      </div>
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
      {section('Decided', c.decisions.map((d) => <li key={d}>{d}</li>))}
      {section('Open questions', c.newQuestions.map((q) => <li key={q}>{q}</li>))}
      {section('Answered', c.answeredQuestions.map((q) => <li key={q} className="muted">{q}</li>))}
      {section('Learned', c.facts.map((f) => <li key={f}>{f}</li>))}
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
