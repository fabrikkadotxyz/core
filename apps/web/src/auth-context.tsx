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
import { syncThemeFromAccount } from './themes.ts';
import { resetOnboarding } from './onboarding.ts';
import { clearWarm, readWarm, writeWarm } from './warm.ts';

interface AuthState {
  user: AuthUser | null;
  /** True until the initial /auth/me has settled, so guards don't flash. */
  loading: boolean;
  setUser: (user: AuthUser | null) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // ADR 0044: a reload trusts who this tab last saw, for drawing only, until /auth/me answers.
  const [user, setUserState] = useState<AuthUser | null>(() => readWarm<AuthUser>('me'));
  const [loading, setLoading] = useState(() => user === null);

  const setUser = useCallback((next: AuthUser | null) => {
    if (next) writeWarm('me', next);
    else clearWarm();
    setUserState(next);
  }, []);

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

  // Signed in, or arrived signed in: the account's theme replaces the device's.
  useEffect(() => {
    if (user) syncThemeFromAccount();
  }, [user?.id]);

  const signOut = useCallback(async () => {
    await auth.logout().catch(() => {});
    resetOnboarding();
    setUser(null);
  }, [setUser]);

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
