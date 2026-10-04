import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth-context.tsx';
import { InvitePage } from './pages/InvitePage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { SessionListPage } from './pages/SessionListPage.tsx';
import { SessionPage } from './pages/SessionPage.tsx';
import { TeamPage } from './pages/TeamPage.tsx';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Unauthenticated on purpose: an invite is how you get an account. */}
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <SessionListPage />
            </RequireAuth>
          }
        />
        <Route
          path="/o/:owner/s/:session"
          element={
            <RequireAuth>
              <SessionPage />
            </RequireAuth>
          }
        />
        <Route
          path="/teams/:id"
          element={
            <RequireAuth>
              <TeamPage />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <main className="centered">Loading…</main>;
  if (!user) {
    // Remember where they were headed so login can return them there.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
