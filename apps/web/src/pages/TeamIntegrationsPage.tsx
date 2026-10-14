/**
 * Organization integrations (M30, ADR 0028), a Settings tab: connections the organization shares.
 *
 * Team owners add and remove them. Every member — and their agents — uses them in
 * the team's sessions wherever they haven't attached their own, and each use is
 * marked as shared. Members see that a connection exists, never its token; only
 * owners see who has been using it.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { teamConnections, ApiError } from '../api.ts';
import { Select } from '../components/Select.tsx';

/** M43: the only answers, so the privacy policy can name them all. */
const KEEP = [30, 60, 90, 180, 365].map((d) => ({ value: String(d), label: d === 365 ? '1 year' : `${d} days` }));
import { useWorkspace } from '../shell/workspace.tsx';

type State = Awaited<ReturnType<typeof teamConnections.list>>;

export function OrganizationIntegrations({ teamId: id }: { teamId: string }) {
  const { teams } = useWorkspace();
  const teamName = teams.find((t) => t.id === id)?.name ?? 'This organization';
  const [state, setState] = useState<State | null | 'missing' | 'failed'>(null);
  const [slug, setSlug] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    teamConnections
      .list(id)
      .then(setState)
      .catch((err) => setState(err instanceof ApiError && err.status === 404 ? 'missing' : 'failed'));
  }, [id]);
  useEffect(load, [load]);

  if (state === null) return <section className="centered">Loading…</section>;
  // Only a 404 means the team isn't yours; anything else (offline, a server error) says so.
  if (state === 'failed') {
    return (
      <section className="centered">
        <div className="card">
          <h1>Couldn't load this organization</h1>
          <p className="muted">Check your connection and try again.</p>
          <button onClick={load}>Try again</button>
          <Link to="/">← Home</Link>
        </div>
      </section>
    );
  }
  if (state === 'missing') {
    return (
      <section className="centered">
        <div className="card">
          <h1>No such organization</h1>
          <p className="muted">It doesn't exist, or you're not on it.</p>
          <Link to="/">← Home</Link>
        </div>
      </section>
    );
  }

  return (
    <>
    <p className="muted">
      Connections {teamName} shares. Everyone in the organization, and their agents, can use them in
      the organization's sessions. Calls run as the organization's account, marked as shared, and anyone's own
      connection with the same name is used instead. Each session still chooses which tools to
      allow.
    </p>

    {state.canManage && !state.encryptionConfigured && (
      <p className="hint danger-hint">
        <code>FABRIKKA_ENCRYPTION_KEY</code> is not set, so tokens can't be stored. Adding a
        connection with a token will be refused rather than saved in plaintext.
      </p>
    )}

    {state.connections.length === 0 && <p className="muted small">No organization connections yet.</p>}
    <ul className="session-list">
      {state.connections.map((c) => (
        <li key={c.id} className="team-member">
          <span>
            <strong>{c.label}</strong> <span className="badge-shared">organization's · shared</span>{' '}
            <span className="muted small">
              {c.slug} · {c.url}
            </span>
            <br />
            <span className="muted small">
              {c.hasCredential ? 'token stored' : 'no token'} · added by {c.addedBy ?? 'someone no longer here'}
            </span>
          </span>
          <span className="spacer" />
          {state.canManage && (
            <button
              className="link small danger"
              title="Removes it from every session of the organization"
              onClick={async () => {
                await teamConnections.remove(id, c.slug).catch(() => {});
                load();
              }}
            >
              remove
            </button>
          )}
        </li>
      ))}
    </ul>

    {state.canManage ? (
      <>
        <h2>Add an organization connection</h2>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await teamConnections.save(id, { slug: slug.trim(), url: url.trim(), credential: token || undefined });
              setSlug('');
              setUrl('');
              setToken('');
              load();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="name, e.g. sentry" aria-label="Connection name" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" aria-label="MCP server URL" />
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="the organization's token"
            type="password"
            autoComplete="off"
            aria-label="Token"
          />
          <button type="submit" disabled={!slug.trim() || !url.trim()}>
            Save organization connection
          </button>
        </form>
        {error && <p className="error">{error}</p>}

        <h2>Recent uses</h2>
        <p className="muted small">
          The vendor's log names the organization's account. This names who acted. Tool names only,
          never what was sent.
        </p>
        <div className="row call-records">
          <span className="small">Keep call records for</span>
          <Select
            label="Keep call records for"
            value={String(state.callRecordDays)}
            options={KEEP}
            onChange={async (v) => {
              setError(null);
              try {
                await teamConnections.setCallRecordDays(id, Number(v));
                load();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
          <span className="muted small">Shortening it deletes older records at once.</span>
        </div>
        {state.uses.length === 0 && <p className="muted small">Nobody has used them yet.</p>}
        <ul className="session-list">
          {state.uses.map((u, i) => (
            <li key={i} className="team-member small">
              <span>
                <strong>{u.agent ? `@${u.agent}` : (u.person ?? 'unknown')}</strong>
                {u.agent && <span className="muted"> for {u.person ?? 'unknown'}</span>}{' '}
                called <code>
                  {u.slug}__{u.toolName}
                </code>
                {u.session && <span className="muted"> in {u.session}</span>}
                {!u.ok && <span className="error"> · failed</span>}
              </span>
              <span className="spacer" />
              <span className="muted">{new Date(u.at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </>
    ) : (
      <>
        <p className="muted small">Only organization owners add or remove organization connections.</p>
        <p className="muted small">
          Who used an organization connection, and when, is kept for {state.callRecordDays} days, for the
          organization's owners.
        </p>
      </>
    )}
    </>
  );
}
