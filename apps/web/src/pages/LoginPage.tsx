import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { auth } from '../api.ts';
import { useAuth } from '../auth-context.tsx';

export function LoginPage() {
  const { user, loading, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <main className="centered">Loading…</main>;
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
    <main className="centered">
      <form className="card" onSubmit={submit}>
        <h1>Fabrikka</h1>
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
          There is no "sign up" link: accounts come from an invite link or the
          admin CLI, and password recovery is an operator action. See ADR 0007.
        */}
        <p className="hint">
          No account? You need an invite link. Forgot your password? Ask whoever
          runs this instance to run <code>admin reset-password</code>.
        </p>
      </form>
    </main>
  );
}
