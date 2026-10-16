/**
 * Home (M28): what's waiting for you, and your teams. Sessions — listing them
 * and starting them — live in the sidebar, beside every page.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { WaitingItem } from '@fabrikka/types';
import { sessions, teams } from '../api.ts';
import { useWorkspace } from '../shell/workspace.tsx';
import { GettingStarted } from '../components/GettingStarted.tsx';

export function HomePage() {
  const { team, teams: myTeams, refresh, selectTeam } = useWorkspace();
  const [waiting, setWaiting] = useState<WaitingItem[]>([]);
  const [teamName, setTeamName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sessions.waiting().then(setWaiting).catch(() => {});
  }, []);

  return (
    <div className="page">
      <main className="column">
        <h1>{team ? team.name : 'Fabrikka'}</h1>

        <GettingStarted />

        {team?.own && <OneOffCard />}

        {waiting.length > 0 && (
          <section className="waiting" aria-label="Waiting for you">
            <h2>Waiting for you</h2>
            <ul className="session-list">
              {waiting.map((w, i) => (
                <li key={i}>
                  <Link to={`/o/${w.session.ownerSlug}/s/${w.session.publicId}`}>
                    <span className="session-title">
                      @{w.from} <span className="muted small">in {w.session.title}</span>
                    </span>
                    <span className="small">{w.text}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="muted small">
          Start a session with the <strong>+</strong> beside <em>{team?.own ? 'One-off sessions' : 'Organization sessions'}</em> or{' '}
          <em>Individual sessions</em> in the sidebar.
        </p>
        {error && <p className="error">{error}</p>}

        <h2>Organizations</h2>
        {myTeams.length === 0 && (
          <p className="muted small">An organization is the people you can add to a session without sending a link.</p>
        )}
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!teamName.trim()) return;
            try {
              const t = await teams.create(teamName.trim());
              setTeamName('');
              selectTeam(t.id);
              refresh();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="New organization name" aria-label="New organization name" />
          <button type="submit" disabled={!teamName.trim()}>
            Create organization
          </button>
        </form>
      </main>
    </div>
  );
}

/**
 * M55 (ADR 0053): a one-off session, from the Self home. A title, one click:
 * the session in your Self and a single-use member invite, and the link to
 * send. The sidebar's + beside One-off sessions lands here with ?one-off=1.
 */
function OneOffCard() {
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
          <div className="row">
            <Link className="button" to={made.path}>
              Open the session
            </Link>
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
