import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthUser } from '@fabrikka/types';
import { auth } from './api.ts';

interface AuthState {
  user: AuthUser | null;
  /** True until the initial /auth/me has settled, so guards don't flash. */
  loading: boolean;
  setUser: (user: AuthUser | null) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    auth
      .me()
      .then((r) => !cancelled && setUser(r.user))
      // A 401 here is the normal "not logged in" case, not an error.
      .catch(() => !cancelled && setUser(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = useCallback(async () => {
    await auth.logout().catch(() => {});
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, setUser, signOut }),
    [user, loading, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
