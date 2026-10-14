/**
 * Password reset by email (M32, ADR 0029): ask for a link, then set a new
 * password with it. Only reachable when the instance has an email transport —
 * the login page offers it then, and the API refuses it otherwise.
 *
 * The link's token arrives in the URL path. It is read once, kept in memory, and
 * the URL is replaced, so it doesn't sit in the address bar, history or a
 * Referer header. See docs/security.md.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { auth } from '../api.ts';
import { AuthStage, Eyebrow } from '../components/AuthStage.tsx';

/** /reset — enter your email, get a link. */
export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (sent) {
    return (
      <AuthStage>
        <div className="card">
          <Eyebrow>Password</Eyebrow>
          <h1>Check your email</h1>
          <p className="muted">
            If <strong>{email}</strong> has an account, a link to choose a new password is on its way.
            It works once, for one hour.
          </p>
          <p className="hint">
            <Link to="/login">← Sign in</Link>
          </p>
        </div>
      </AuthStage>
    );
  }

  return (
    <AuthStage>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            await auth.requestReset(email.trim());
            setSent(true);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Eyebrow>Password</Eyebrow>
        <h1>Forgot password</h1>
        <p className="muted">We'll email you a link to choose a new one.</p>
        <label>
          Email
          <input id="reset-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !email.trim()}>
          {busy ? 'Sending…' : 'Send link'}
        </button>
        <p className="hint">
          <Link to="/login">← Sign in</Link>
        </p>
      </form>
    </AuthStage>
  );
}

/** /reset/:token — the page the email links to. */
export function ResetPasswordPage() {
  const { token: fromUrl = '' } = useParams();
  const token = useRef(fromUrl);
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Take the token out of the address bar as soon as it's in memory.
  useEffect(() => {
    if (fromUrl) window.history.replaceState(null, '', '/reset/new-password');
  }, [fromUrl]);

  if (done) {
    return (
      <AuthStage>
        <div className="card">
          <Eyebrow>Password</Eyebrow>
          <h1>Password changed</h1>
          <p className="muted">You've been signed out everywhere else. Sign in with your new password.</p>
          <p className="hint">
            <Link to="/login">Sign in →</Link>
          </p>
        </div>
      </AuthStage>
    );
  }

  return (
    <AuthStage>
      <form
        className="card"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            await auth.confirmReset(token.current, password);
            setDone(true);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Eyebrow>Password</Eyebrow>
        <h1>Choose a new password</h1>
        <label>
          New password
          <input
            id="reset-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <p className="hint">At least 8 characters.</p>
        {error && (
          <p className="error">
            {error} <Link to="/reset">Get a new link</Link>
          </p>
        )}
        <button type="submit" disabled={busy || password.length < 8 || !token.current}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </form>
    </AuthStage>
  );
}
