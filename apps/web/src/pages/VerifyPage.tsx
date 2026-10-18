/**
 * /verify/:token (M64): the page a confirmation link opens. It uses the token
 * once and says what happened. Signed in or not: the link is the proof.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { auth } from '../api.ts';
import { useAuth } from '../auth-context.tsx';
import { AuthStage, Eyebrow } from '../components/AuthStage.tsx';

export function VerifyPage() {
  const { token: fromUrl = '' } = useParams();
  const token = useRef(fromUrl);
  const { user, setUser } = useAuth();
  const [state, setState] = useState<{ ok: true; email: string; changed: boolean } | { ok: false; error: string } | null>(null);

  useEffect(() => {
    if (fromUrl) window.history.replaceState(null, '', '/verify/done');
    if (!token.current) {
      setState({ ok: false, error: 'this link is incomplete' });
      return;
    }
    auth
      .verify(token.current)
      .then((r) => {
        setState(r);
        if (user) setUser({ ...user, email: r.email, emailVerified: true });
      })
      .catch((err) => setState({ ok: false, error: (err as Error).message }));
    // Once, with the token the page opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <AuthStage>
      <div className="card">
        <Eyebrow>Email</Eyebrow>
        {!state && <h1>One moment…</h1>}
        {state?.ok && (
          <>
            <h1>{state.changed ? 'Address changed' : 'Address confirmed'}</h1>
            <p className="muted">
              {state.changed ? `Your account now uses ${state.email}.` : `${state.email} is yours. You can now download or delete your account, and change its address.`}
            </p>
          </>
        )}
        {state && !state.ok && (
          <>
            <h1>That link didn't work</h1>
            <p className="muted">{state.error}</p>
          </>
        )}
        <p className="hint">{user ? <Link to="/settings/account">Back to your account →</Link> : <Link to="/login">Sign in →</Link>}</p>
      </div>
    </AuthStage>
  );
}
