/**
 * Personal integrations (M28): your own connections, outside any session.
 *
 * A connection is yours — your account, your token, sealed at rest and never
 * shown again (ADRs 0004, 0014). Attaching one to a session, and granting its
 * tools there, stays in that session's Setup.
 */
import { useCallback, useEffect, useState } from 'react';
import { connections } from '../api.ts';

type Conn = Awaited<ReturnType<typeof connections.list>>['connections'][number];

export function IntegrationsPage() {
  const [list, setList] = useState<Conn[] | null>(null);
  const [encryption, setEncryption] = useState(true);
  const [slug, setSlug] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    connections
      .list()
      .then((r) => {
        setList(r.connections);
        setEncryption(r.encryptionConfigured);
      })
      .catch(() => setList([]));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="page">
      <main className="column">
        <h1>Personal integrations</h1>
        <p className="muted">
          Your own connections. Calls made with them run as you — your account is what the
          vendor's audit log names. Attach one to a session from that session's Setup.
        </p>

        {!encryption && (
          <p className="hint danger-hint">
            <code>FABRIKKA_ENCRYPTION_KEY</code> is not set, so tokens can't be stored. Adding a
            connection with a token will be refused rather than saved in plaintext.
          </p>
        )}

        {list && list.length === 0 && <p className="muted small">No connections yet.</p>}
        <ul className="session-list">
          {list?.map((c) => (
            <li key={c.id} className="team-member">
              <span>
                <strong>{c.label}</strong> <span className="muted small">{c.slug} · {c.url}</span>
                <br />
                <span className="muted small">
                  {c.hasCredential ? 'token stored' : 'no token'} · in {c.sessions} session{c.sessions === 1 ? '' : 's'}
                </span>
              </span>
              <span className="spacer" />
              <button
                className="link small danger"
                title={c.sessions ? `Also removes it from ${c.sessions} session${c.sessions === 1 ? '' : 's'}` : undefined}
                onClick={async () => {
                  await connections.remove(c.slug).catch(() => {});
                  load();
                }}
              >
                remove{c.sessions ? ` (from ${c.sessions} session${c.sessions === 1 ? '' : 's'})` : ''}
              </button>
            </li>
          ))}
        </ul>

        <h2>Add a connection</h2>
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await connections.save({ slug: slug.trim(), url: url.trim(), credential: token || undefined });
              setSlug('');
              setUrl('');
              setToken('');
              load();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="name, e.g. github" aria-label="Connection name" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" aria-label="MCP server URL" />
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="token (yours; optional)"
            type="password"
            autoComplete="off"
            aria-label="Token"
          />
          <button type="submit" disabled={!slug.trim() || !url.trim()}>
            Save connection
          </button>
        </form>
        <p className="muted small">
          Connecting by category — Jira, Linear, GitHub in one click — comes with M18.
        </p>
        {error && <p className="error">{error}</p>}
      </main>
    </div>
  );
}
