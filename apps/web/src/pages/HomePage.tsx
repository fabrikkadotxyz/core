/**
 * Home (M28, M56): what needs you, what is running, what changed; in Self the
 * one-off session card (M55) first. Sessions live in the sidebar, beside every
 * page; organizations are made in Settings (2026-10-16).
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { HomeView } from '@fabrikka/types';
import { sessions } from '../api.ts';
import { useWorkspace } from '../shell/workspace.tsx';
import { GettingStarted } from '../components/GettingStarted.tsx';
import { timeAgo } from '../outputs/Outputs.tsx';

/** "7 days", "1 day", "a few hours": how long an invite link has left. */
function daysUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 1 ? `${hours} hour${hours === 1 ? '' : 's'}` : 'less than an hour';
}

export function HomePage() {
  const { team } = useWorkspace();
  const [home, setHome] = useState<HomeView | null>(null);
  const load = () => sessions.home().then(setHome).catch(() => {});
  useEffect(() => {
    load();
    // M56: the home is what is going on now; it follows the person's stream too (M42), so a refresh on focus is enough.
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, []);
  const room = (s: { ownerSlug: string; publicId: string }) => `/o/${s.ownerSlug}/s/${s.publicId}`;
  const empty = home && home.needsYou.length + home.running.length + home.finished.length + home.changed.length + home.waitingOnOthers.length + home.openInvites.length === 0;

  return (
    <div className="page">
      <main className="column home">
        <h1>{team ? team.name : 'Fabrikka'}</h1>

        <GettingStarted />

        {team?.own && <OneOffCard onMade={load} />}

        {home && home.needsYou.length > 0 && (
          <section className="home-section" aria-label="Needs you">
            <h2>Needs you</h2>
            <ul className="session-list">
              {home.needsYou.map((w, i) => (
                <li key={i}>
                  <Link to={room(w.session)}>
                    <span className="session-title">
                      @{w.from} <span className="muted small">in {w.session.title} · {timeAgo(w.at)}</span>
                    </span>
                    <span className="small">{w.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {home && home.running.length > 0 && (
          <section className="home-section" aria-label="Running now">
            <h2>Running now</h2>
            <ul className="session-list">
              {home.running.map((r) => (
                <li key={r.id}>
                  <Link to={room(r.session)}>
                    <span className="session-title">
                      <span className="live-dot" aria-hidden /> @{r.agent} <span className="muted small">in {r.session.title} · since {timeAgo(r.startedAt)}</span>
                    </span>
                    <span className="small activity-line">
                      {r.last ? `${r.last.tool}${r.last.detail ? ` ${r.last.detail}` : ''}` : 'working…'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {home && home.finished.length > 0 && (
          <section className="home-section" aria-label="Finished while you were away">
            <h2>Finished while you were away</h2>
            <ul className="session-list">
              {home.finished.map((r) => (
                <li key={r.id}>
                  <Link to={room(r.session)}>
                    <span className="session-title">
                      @{r.agent} <span className={`badge run-${r.status}`}>{r.status}</span>{' '}
                      <span className="muted small">in {r.session.title} · {timeAgo(r.endedAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {home && home.changed.length > 0 && (
          <section className="home-section" aria-label="Since you were away">
            <h2>Since you were away</h2>
            <ul className="session-list">
              {home.changed.map((c) => (
                <li key={c.session.publicId}>
                  <Link to={room(c.session)}>
                    <span className="session-title">{c.session.title}</span>
                    <span className="muted small">
                      {c.messages} new message{c.messages === 1 ? '' : 's'} · {timeAgo(c.lastAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {home && home.waitingOnOthers.length > 0 && (
          <section className="home-section" aria-label="Waiting on others">
            <h2>Waiting on others</h2>
            <ul className="session-list">
              {home.waitingOnOthers.map((w) => (
                <li key={w.session.publicId}>
                  <Link to={room(w.session)}>
                    <span className="session-title">
                      {w.to} <span className="muted small">in {w.session.title} · you asked {timeAgo(w.at)}</span>
                    </span>
                    <span className="small">{w.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {home && home.openInvites.length > 0 && (
          <section className="home-section" aria-label="One-off sessions, open">
            <h2>One-off sessions, open</h2>
            <p className="muted small">Links you sent that nobody has opened yet.</p>
            <ul className="session-list">
              {home.openInvites.map((inv) => (
                <li key={inv.id} className="with-actions">
                  <Link to={room(inv.session)}>
                    <span className="session-title">{inv.session.title}</span>
                    <span className="muted small">
                      sent {timeAgo(inv.createdAt)} · expires in {daysUntil(inv.expiresAt)}
                    </span>
                  </Link>
                  <button
                    className="link small danger"
                    onClick={async () => {
                      await sessions.revokeInvite({ owner: inv.session.ownerSlug, session: inv.session.publicId }, inv.id).catch(() => {});
                      load();
                    }}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {home && home.computers.length > 0 && (
          <section className="home-section" aria-label="Your computers">
            <h2>Your computers</h2>
            <ul className="session-list">
              {home.computers.map((d) => (
                <li key={d.id}>
                  <Link to="/settings/devices">
                    <span className="session-title">
                      {d.name} <span className={d.online ? 'status on' : 'status off'}>{d.online ? 'online' : 'offline'}</span>
                    </span>
                    <span className="muted small">
                      {d.agents === 0 ? 'no agents bound' : `${d.agents} agent${d.agents === 1 ? '' : 's'} bound`}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {empty && (
          <p className="muted small">
            Nothing needs you. Start a session with the <strong>+</strong> beside{' '}
            <em>{team?.own ? 'One-off sessions' : 'Organization sessions'}</em> or <em>Individual sessions</em> in the sidebar.
          </p>
        )}
      </main>
    </div>
  );
}

/**
 * M55 (ADR 0053): a one-off session, from the Self home. A title, one click:
 * the session in your Self and a single-use member invite, and the link to
 * send. The sidebar's + beside One-off sessions lands here with ?one-off=1.
 */
function OneOffCard({ onMade }: { onMade: () => void }) {
  const [params] = useSearchParams();
  const [title, setTitle] = useState('');
  const [made, setMade] = useState<{ url: string; path: string; title: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const { refresh } = useWorkspace();
  useEffect(() => {
    if (params.get('one-off') === '1') input.current?.focus();
  }, [params]);

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const s = await sessions.create(title.trim(), undefined, 'private');
      const inv = await sessions.createInvite({ owner: s.ownerSlug, session: s.publicId }, {});
      setMade({ url: inv.url, path: `/o/${s.ownerSlug}/s/${s.publicId}`, title: s.title });
      setTitle('');
      refresh();
      onMade();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card-hint one-off" aria-label="One-off session">
      <h2>One-off session</h2>
      <p className="muted small">
        For one piece of work with one person, outside any organization. One link in, nothing to set up for them.
      </p>
      {made ? (
        <div className="stack">
          <p className="small">
            <strong>{made.title}</strong> is ready. Send this link; whoever opens it joins this session, nothing else.
          </p>
          <div className="row copy-row">
            <code className="endpoint">{made.url}</code>
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(made.url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  // Clipboard refused: the link is selectable text.
                }
              }}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
          <div className="row one-off-actions">
            <Link className="button" to={made.path}>
              Open the session
            </Link>
            <span className="spacer" />
            <button className="link small" onClick={() => setMade(null)}>
              Start another
            </button>
          </div>
        </div>
      ) : (
        <form className="inline-form" onSubmit={start}>
          <input ref={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is it about?" aria-label="One-off session title" />
          <button type="submit" disabled={!title.trim() || busy}>
            {busy ? 'Starting…' : 'Start a one-off session'}
          </button>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
