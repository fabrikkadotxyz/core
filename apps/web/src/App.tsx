import { Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth-context.tsx';
import { InvitePage } from './pages/InvitePage.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { SetupPage } from './pages/SetupPage.tsx';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/ResetPage.tsx';
import { VerifyPage } from './pages/VerifyPage.tsx';
import { AllSessionsPage } from './pages/AllSessionsPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { PairPage } from './pages/PairPage.tsx';
import { AppShell } from './shell/AppShell.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { IntegrationsHubPage } from './pages/IntegrationsHubPage.tsx';
import { OutputPage } from './pages/OutputPage.tsx';
import { useWorkspace, WorkspaceProvider } from './shell/workspace.tsx';
import { SessionPage } from './pages/SessionPage.tsx';
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
        <Route path="/verify/:token" element={<VerifyPage />} />
        {/* M47: once per account, before anything else. Outside the shell: no sidebar yet. */}
        <Route path="/welcome" element={<RequireAuth><WelcomePage /></RequireAuth>} />
        {/* M49 (ADR 0045): a room's output alone, in its own tab or window. No shell: no sidebar. */}
        <Route path="/o/:owner/s/:session/output" element={<RequireAuth><RequireWelcomed><OutputPage /></RequireWelcomed></RequireAuth>} />
        {/* M28: every signed-in page lives in one shell, beside one sidebar that
            stays mounted as you move between pages. */}
        <Route element={<Shell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/sessions" element={<AllSessionsPage />} />
          <Route path="/teams/:id/sessions" element={<AllSessionsPage />} />
          {/* M51 (ADR 0048): Integrations is a place of its own; Settings is People, Your devices, Appearance.
              Every older address forwards, with its query, so notices and the OAuth callback keep working. */}
          <Route path="/integrations" element={<IntegrationsHubPage scope="personal" />} />
          <Route path="/integrations/organization" element={<IntegrationsHubPage scope="organization" />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/:tab" element={<SettingsPage />} />
          <Route path="/devices" element={<Moved to="/settings/devices" />} />
          <Route path="/appearance" element={<Moved to="/settings/appearance" />} />
          <Route path="/teams/:id" element={<MovedToOrganization to="/settings/people" />} />
          <Route path="/teams/:id/integrations" element={<MovedToOrganization to="/integrations/organization" />} />
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

/** A page that moved into Settings: forward, keeping the query (a notice, a scope). */
function Moved({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={to + search} replace />;
}

/** An organization's old page: choose that organization in the switcher, then forward to where it lives now. */
function MovedToOrganization({ to }: { to: string }) {
  const { id } = useParams();
  const { team, selectTeam } = useWorkspace();
  useEffect(() => {
    if (id && team?.id !== id) selectTeam(id);
  }, [id, team, selectTeam]);
  return <Navigate to={to} replace />;
}
