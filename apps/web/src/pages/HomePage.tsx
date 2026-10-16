/**
 * Home (M28, M56): a board of what is going on, from one answer of the server.
 * Two columns: Now (needs you, running, waiting on others) and While you were
 * away (finished, rooms with news); a slim one-off bar on top in Self (M55);
 * computers and open links as chips at the bottom. The owner chose this
 * arrangement from three on 2026-10-16. Sessions live in the sidebar;
 * organizations are made in Settings.
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

type Room = { ownerSlug: string; publicId: string; title: string };
const room = (s: Room) => `/o/${s.ownerSlug}/s/${s.publicId}`;

/** A card on the board: a heading with a count, a kind stripe, and its items. */
function Card({ title, label, tone, count, children }: { title: string; label?: string; tone?: 'attn' | 'ok' | 'info' | 'warn'; count?: number; children: React.ReactNode }) {
  return (
    <section className={`home-card${tone ? ` stripe-${tone}` : ''}`} aria-label={label ?? title}>
      <h3>
        {title}
        {count !== undefined && <span className={`home-count${tone ? ` ${tone}` : ''}`}>{count}</span>}
      </h3>
      {children}
    </section>
  );
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
  const now = home ? home.needsYou.length + home.running.length + home.waitingOnOthers.length : 0;
  const away = home ? home.finished.length + home.changed.length : 0;
  const empty = home && now + away + home.openInvites.length === 0;

  return (
    <div className="page">
      <main className="column home">
        <h1>{team ? team.name : 'Fabrikka'}</h1>

        <GettingStarted />

        {team?.own && <OneOffBar onMade={load} />}

        {home && (now > 0 || away > 0) && (
          <div className="home-cols">
            <div className="home-col">
              <p className="home-h">Now</p>
              {home.needsYou.length > 0 && (
                <Card title="Needs you" tone="attn" count={home.needsYou.length}>
                  <ul className="home-list">
                    {home.needsYou.map((w, i) => (
                      <li key={i}>
                        <Link to={room(w.session)}>
                          <span className="t">
                            <strong>@{w.from}</strong>
                            <span className="m">in {w.session.title} · {timeAgo(w.at)}</span>
                          </span>
                          <span className="x">{w.text}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {home.running.length > 0 && (
                <Card title="Running now" tone="ok" count={home.running.length}>
                  <ul className="home-list">
                    {home.running.map((r) => (
                      <li key={r.id}>
                        <Link to={room(r.session)}>
                          <span className="t">
                            <span className="live-dot" aria-hidden />
                            <strong>@{r.agent}</strong>
                            <span className="m">in {r.session.title} · since {timeAgo(r.startedAt)}</span>
                          </span>
                          <span className="x activity-line">{r.last ? `${r.last.tool}${r.last.detail ? ` ${r.last.detail}` : ''}` : 'working…'}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {home.waitingOnOthers.length > 0 && (
                <Card title="Waiting on others" tone="info">
                  <ul className="home-list">
                    {home.waitingOnOthers.map((w) => (
                      <li key={w.session.publicId}>
                        <Link to={room(w.session)}>
                          <span className="t">
                            <strong>{w.to}</strong>
                            <span className="m">in {w.session.title} · you asked {timeAgo(w.at)}</span>
                          </span>
                          <span className="x">{w.text}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {now === 0 && <p className="muted small home-quiet">Nothing needs you right now.</p>}
            </div>
            <div className="home-col">
              <p className="home-h">While you were away</p>
              {home.finished.length > 0 && (
                <Card title="Finished" label="Finished while you were away">
                  <ul className="home-list">
                    {home.finished.map((r) => (
                      <li key={r.id}>
                        <Link to={room(r.session)}>
                          <span className="t">
                            <strong>@{r.agent}</strong>
                            <span className={`pill run-${r.status}`}>{r.status}</span>
                            <span className="m">in {r.session.title} · {timeAgo(r.endedAt)}</span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {home.changed.length > 0 && (
                <Card title="Rooms with news" label="Since you were away" tone="warn" count={home.changed.length}>
                  <ul className="home-list">
                    {home.changed.map((c) => (
                      <li key={c.session.publicId}>
                        <Link to={room(c.session)}>
                          <span className="t">
                            <strong>{c.session.title}</strong>
                          </span>
                          <span className="m">
                            {c.messages} new message{c.messages === 1 ? '' : 's'} · {timeAgo(c.lastAt)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              {away === 0 && <p className="muted small home-quiet">Nothing happened while you were away.</p>}
            </div>
          </div>
        )}

        {home && (home.computers.length > 0 || home.openInvites.length > 0) && (
          <div className="home-foot">
            {home.computers.length > 0 && (
              <Card title="Your computers">
                <div className="chips">
                  {home.computers.map((d) => (
                    <Link key={d.id} className="chip" to="/settings/devices">
                      <span className={d.online ? 'dot on' : 'dot off'} aria-hidden />
                      {d.name}
                      <span className="home-count">{d.agents === 0 ? 'no agents' : `${d.agents} agent${d.agents === 1 ? '' : 's'}`}</span>
                      {!d.online && <span className="m">offline</span>}
                    </Link>
                  ))}
                </div>
              </Card>
            )}
            {home.openInvites.length > 0 && (
              <Card title="One-off sessions, open" label="One-off sessions, open">
                <div className="chips">
                  {home.openInvites.map((inv) => (
                    <span key={inv.id} className="chip">
                      <Link to={room(inv.session)}>{inv.session.title}</Link>
                      <span className="home-count">{daysUntil(inv.expiresAt)} left</span>
                      <button
                        className="link small danger"
                        onClick={async () => {
                          await sessions.revokeInvite({ owner: inv.session.ownerSlug, session: inv.session.publicId }, inv.id).catch(() => {});
                          load();
                        }}
                      >
                        Revoke
                      </button>
                    </span>
                  ))}
                </div>
              </Card>
            )}
          </div>
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
 * M55 (ADR 0053): a one-off session, from the Self home, as one slim bar. A
 * title, one click: the session in your Self and a single-use member invite,
 * and the link to send. The sidebar's + beside One-off sessions lands here
 * with ?one-off=1.
 */
function OneOffBar({ onMade }: { onMade: () => void }) {
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
    <section className="one-off-bar" aria-label="One-off session">
      {made ? (
        <div className="one-off-row">
          <span className="lbl">
            <strong>{made.title}</strong> is ready
          </span>
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
          <Link className="button" to={made.path}>
            Open the session
          </Link>
          <span className="spacer" />
          <button className="link small" onClick={() => setMade(null)}>
            Start another
          </button>
        </div>
      ) : (
        <form className="one-off-row" onSubmit={start}>
          <span className="lbl">One-off session</span>
          <input ref={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What is it about?" aria-label="One-off session title" />
          <button type="submit" disabled={!title.trim() || busy}>
            {busy ? 'Starting…' : 'Start a one-off session'}
          </button>
          <span className="muted small hint-inline">One link, one person, nothing to set up for them.</span>
        </form>
      )}
      {made && <p className="muted small">Send the link; whoever opens it joins this session, nothing else.</p>}
      {error && <p className="error small">{error}</p>}
    </section>
  );
}
