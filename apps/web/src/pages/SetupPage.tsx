/**
 * Set up a fresh instance (M39, ADR 0035): create its owner with the setup code
 * from the deploy platform's settings or the server log. Gone once anyone exists.
 */
import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { auth } from '../api.ts';
import { useAuth } from '../auth-context.tsx';

export function SetupPage() {
  const { user, loading, setUser } = useAuth();
  const navigate = useNavigate();
  const [needed, setNeeded] = useState<boolean | null>(null);
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    auth.setupNeeded().then((r) => setNeeded(r.needed)).catch(() => setNeeded(false));
  }, []);

  if (loading || needed === null) return <main className="centered">Loading…</main>;
  if (user || !needed) return <Navigate to="/" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { user: owner } = await auth.setup({ code, email, displayName, password });
      setUser(owner);
      navigate('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="centered">
      <form className="card" onSubmit={submit}>
        <h1>Set up Fabrikka</h1>
        <p className="muted">
          Create the owner of this instance. The setup code is in your deploy platform's environment settings
          (<code>FABRIKKA_SETUP_CODE</code>) or in the server's log.
        </p>

        <label>
          Setup code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>
        <label>
          Your name
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" required />
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create owner'}
        </button>
      </form>
    </main>
  );
}
