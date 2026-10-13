import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth-context.tsx';
import { InvitePage } from './pages/InvitePage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { SetupPage } from './pages/SetupPage.tsx';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/ResetPage.tsx';
import { AllSessionsPage } from './pages/AllSessionsPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { IntegrationsPage } from './pages/IntegrationsPage.tsx';
import { TeamIntegrationsPage } from './pages/TeamIntegrationsPage.tsx';
import { DevicesPage } from './pages/DevicesPage.tsx';
import { AppearancePage } from './pages/AppearancePage.tsx';
import { PairPage } from './pages/PairPage.tsx';
import { AppShell } from './shell/AppShell.tsx';
import { WorkspaceProvider } from './shell/workspace.tsx';
import { SessionPage } from './pages/SessionPage.tsx';
import { TeamPage } from './pages/TeamPage.tsx';
import { WelcomePage } from './pages/WelcomePage.tsx';
import { useOnboarding } from './onboarding.ts';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<SetupPage />} />
        {/* Unauthenticated on purpose: an invite is how you get an account. */}
        <Route path="/invite/:token" element={<InvitePage />} />
        {/* M32: password reset by email, offered only with an email transport. */}
        <Route path="/reset" element={<ForgotPasswordPage />} />
        <Route path="/reset/:token" element={<ResetPasswordPage />} />
        {/* M47: once per account, before anything else. Outside the shell: no sidebar yet. */}
        <Route path="/welcome" element={<RequireAuth><WelcomePage /></RequireAuth>} />
        {/* M28: every signed-in page lives in one shell, beside one sidebar that
            stays mounted as you move between pages. */}
        <Route element={<Shell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/sessions" element={<AllSessionsPage />} />
          <Route path="/teams/:id/sessions" element={<AllSessionsPage />} />
          <Route path="/teams/:id" element={<TeamPage />} />
          <Route path="/teams/:id/integrations" element={<TeamIntegrationsPage />} />
          <Route path="/integrations" element={<IntegrationsPage />} />
          <Route path="/devices" element={<DevicesPage />} />
          <Route path="/appearance" element={<AppearancePage />} />
          <Route path="/pair/:code" element={<PairPage />} />
          <Route path="/o/:owner/s/:session" element={<SessionPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}

/** Signed in, inside the workspace frame. */
function Shell() {
  return (
    <RequireAuth>
      <RequireWelcomed>
        <WorkspaceProvider>
          <AppShell>
            <Outlet />
          </AppShell>
        </WorkspaceProvider>
      </RequireWelcomed>
    </RequireAuth>
  );
}

/** M47: an account that hasn't seen the welcome sees it first, then comes back here. */
function RequireWelcomed({ children }: { children: ReactNode }) {
  const { state, failed } = useOnboarding();
  const location = useLocation();
  if (!state && !failed) return <main className="centered">Loading…</main>;
  // If the check itself fails, let them in: the welcome is a nicety, not a gate.
  if (state && !state.welcomed) return <Navigate to="/welcome" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
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
