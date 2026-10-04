/**
 * Invite redemption.
 *
 * This is the only way to get an account: there is no open signup. An invite
 * link is delivered out of band — Slack, Signal, spoken aloud — because nothing
 * here requires a mail server. See ADR 0007.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { auth, invites, type InviteDestination } from '../api.ts';
import { useAuth } from '../auth-context.tsx';

export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const { user, loading, setUser } = useAuth();

  const [preview, setPreview] = useState<
    { kind: 'session' | 'team'; title: string; invitedEmail: string | null } | null | 'invalid'
  >(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    invites
      .preview(token)
      .then((p) => {
        setPreview(p);
        // A scoped invite already knows the address; don't make them type it.
        if (p.invitedEmail) setEmail(p.invitedEmail);
      })
      .catch(() => setPreview('invalid'));
  }, [token]);

  if (preview === null || loading) return <main className="centered">Loading…</main>;

  if (preview === 'invalid') {
    return (
      <main className="centered">
        <div className="card">
          <h1>This invite can't be used</h1>
          <p className="muted">
            It may have already been redeemed, been revoked, or expired. Invites
            are single-use and expire after 7 days — ask for a fresh link.
          </p>
        </div>
      </main>
    );
  }

  /** A session invite opens the session; a team invite opens the team (M21). */
  const go = (to: InviteDestination) =>
    navigate(to.team ? `/teams/${to.team.id}` : `/o/${to.session!.ownerSlug}/s/${to.session!.publicId}`, {
      replace: true,
    });

  /** Already signed in: just join. */
  const join = async () => {
    setError(null);
    setBusy(true);
    try {
      go(await invites.redeem(token));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** New account: signup redeems the invite in the same request. */
  const signup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { user: created, ...destination } = await auth.signup({
        token,
        email,
        password,
        displayName,
      });
      setUser(created);
      go(destination);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (user) {
    return (
      <main className="centered">
        <div className="card">
          <h1>{preview.kind === 'team' ? `Join the team “${preview.title}”` : `Join “${preview.title}”`}</h1>
          <p className="muted">
            You're signed in as {user.email}.
            {preview.invitedEmail && preview.invitedEmail !== user.email && (
              <>
                {' '}
                This invite is addressed to <strong>{preview.invitedEmail}</strong>,
                so it will be refused for this account.
              </>
            )}
          </p>
          {error && <p className="error">{error}</p>}
          <button onClick={join} disabled={busy}>
            {busy ? 'Joining…' : preview.kind === 'team' ? 'Join team' : 'Join session'}
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="centered">
      <form className="card" onSubmit={signup}>
        <h1>{preview.kind === 'team' ? `Join the team “${preview.title}”` : `Join “${preview.title}”`}</h1>
        <p className="muted">Create an account to join this {preview.kind === 'team' ? 'team' : 'session'}.</p>

        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            readOnly={!!preview.invitedEmail}
            autoComplete="username"
            required
          />
        </label>
        {preview.invitedEmail && (
          <p className="hint">This invite is only valid for {preview.invitedEmail}.</p>
        )}

        <label>
          Display name
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="how you'll appear in the timeline"
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            autoComplete="new-password"
            required
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create account and join'}
        </button>
      </form>
    </main>
  );
}
