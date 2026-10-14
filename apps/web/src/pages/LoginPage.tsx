import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { auth } from '../api.ts';
import { useAuth } from '../auth-context.tsx';
import { AuthStage, Eyebrow } from '../components/AuthStage.tsx';

export function LoginPage() {
  const { user, loading, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offers, setOffers] = useState<{ passwordReset: boolean; signupUrl: string | null } | null>(null);

  // A fresh instance has nobody to sign in as: send whoever just deployed it to setup (ADR 0035).
  const [needsSetup, setNeedsSetup] = useState(false);
  useEffect(() => {
    auth.options().then(setOffers).catch(() => setOffers({ passwordReset: false, signupUrl: null }));
    auth.setupNeeded().then((r) => setNeedsSetup(r.needed)).catch(() => {});
  }, []);

  if (loading) return <AuthStage />;
  if (needsSetup && !user) return <Navigate to="/setup" replace />;
  if (user) {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { user: signedIn } = await auth.login({ email, password });
      setUser(signedIn);
      navigate((location.state as { from?: string } | null)?.from ?? '/', {
        replace: true,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthStage>
      <form className="card" onSubmit={submit}>
        <Eyebrow>Sign in</Eyebrow>
        <h1>Welcome back</h1>
        <p className="muted">Sign in to your sessions.</p>

        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {/*
          What's offered depends on the instance, never on a mode (ADR 0007, 0029):
          reset by email only with an email transport, and "Create an account"
          only if a deployment's extension advertised a sign-up page. Otherwise
          accounts come from invite links, and recovery is the operator's CLI.
        */}
        {offers?.passwordReset && (
          <p className="hint">
            <Link to="/reset">Forgot password?</Link>
          </p>
        )}
        {offers?.signupUrl && (
          <p className="hint">
            New here? <a href={offers.signupUrl}>Create an account</a>
          </p>
        )}
        {offers && !offers.signupUrl && (
          <p className="hint">No account? You need an invite link.</p>
        )}
        {offers && !offers.passwordReset && (
          <p className="hint">
            Forgot your password? Ask whoever runs this instance to run <code>admin reset-password</code>.
          </p>
        )}
      </form>
    </AuthStage>
  );
}
