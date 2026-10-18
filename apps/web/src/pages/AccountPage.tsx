/**
 * Account (M58, ADR 0057), a Settings tab: who you are here, and the door out.
 *
 * Deleting asks for the password again, says what stays, and offers the one
 * choice: keep your name on what you wrote (default) or have it replaced by
 * "former-member". The account is deactivated at once; signing in within the
 * grace period cancels the deletion. docs/security.md, "Leaving".
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuditEventView } from '@fabrikka/types';
import { auth } from '../api.ts';
import { useAuth } from '../auth-context.tsx';
import { describe } from './ActivityPage.tsx';

/** M60 (ADR 0058): what you did, and what was done to you, anywhere. */
function MyActivity() {
  const [events, setEvents] = useState<AuditEventView[] | null>(null);
  useEffect(() => {
    auth.myAudit(30).then((r) => setEvents(r.events)).catch(() => setEvents([]));
  }, []);
  return (
    <section aria-label="Recent activity on your account">
      <h2>Recent activity on your account</h2>
      <p className="muted small">Sign-ins, invites, rooms you were added to or removed from, and anything done to your account. Never what you wrote.</p>
      {events === null && <p className="muted small">Loading…</p>}
      {events && events.length === 0 && <p className="muted small">Nothing yet.</p>}
      {events && events.length > 0 && (
        <ul className="team-members">
          {events.map((e) => (
            <li key={e.id} className="team-member small">
              <span>
                {describe(e)}
                {e.team?.name && <span className="muted"> · {e.team.name}</span>}
                {e.outcome !== 'ok' && <span className="error"> · {e.outcome}</span>}
              </span>
              <span className="spacer" />
              <span className="muted">{new Date(e.at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** M62: the right of access and portability, self-served, behind the password. */
function DownloadMyData() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      const { blob, filename } = await auth.exportMyData(password);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setDone(filename);
      setPassword('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Download my data">
      <h2>Download my data</h2>
      <p className="muted small">
        One zip of everything this instance holds about you: your profile, where you are, every message you wrote, your
        connections by name, your computers, agents and activity. Never other people's messages, a room's documents, tool
        output or a credential. A room's full record is exported by its owner, from the room.
      </p>
      <form className="stack" onSubmit={submit}>
        <label>
          Your password, to confirm it is you
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="error">{error}</p>}
        {done && <p className="hint">Saved as {done}.</p>}
        <p>
          <button type="submit" disabled={busy || !password}>
            {busy ? 'Preparing…' : 'Download my data'}
          </button>
        </p>
      </form>
    </section>
  );
}

export function Account() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [eraseName, setEraseName] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await auth.requestDeletion({ password, eraseName });
      const date = new Date(r.effectiveAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
      await signOut();
      navigate('/login', {
        replace: true,
        state: {
          notice: `Your account is deactivated and will be deleted on ${date}. Changed your mind? Sign in before then and the deletion is cancelled.`,
        },
      });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <section aria-label="Who you are">
        <h2>Who you are</h2>
        <p>
          <strong>{user.displayName}</strong> <span className="muted small">{user.email}</span>
        </p>
        <p className="muted small">Your name in a room can differ: rename yourself there, in People.</p>
      </section>

      <MyActivity />

      <DownloadMyData />

      <section aria-label="Delete my account">
        <h2>Delete my account</h2>
        <p className="muted small">
          Your email, password, devices, connections and the agents you registered are removed. What you wrote in rooms
          other people are in stays there, because it is their record too. Rooms only you were in are deleted with the
          account. Rooms and organizations you own pass to their oldest remaining member.
        </p>
        {!open ? (
          <button onClick={() => setOpen(true)}>Delete my account…</button>
        ) : (
          <form className="stack" onSubmit={submit}>
            <fieldset>
              <legend>What stays on what you wrote</legend>
              <label className="check">
                <input type="radio" name="name" checked={!eraseName} onChange={() => setEraseName(false)} /> Keep my name,{' '}
                <strong>{user.displayName}</strong>, shown as deactivated
              </label>
              <label className="check">
                <input type="radio" name="name" checked={eraseName} onChange={() => setEraseName(true)} /> Remove my name: show{' '}
                <code>former-member</code> instead. This cannot be undone.
              </label>
            </fieldset>
            <label>
              Your password, to confirm it is you
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </label>
            {error && <p className="error">{error}</p>}
            <p className="muted small">
              You are signed out everywhere at once. Signing in again within 14 days cancels the deletion; after that it is final.
            </p>
            <p>
              <button type="submit" disabled={busy || !password}>
                {busy ? 'Deleting…' : 'Delete my account'}
              </button>{' '}
              <button type="button" className="link" onClick={() => setOpen(false)} disabled={busy}>
                Keep it
              </button>
            </p>
          </form>
        )}
      </section>
    </>
  );
}
