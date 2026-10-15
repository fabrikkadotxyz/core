/**
 * Integrations, a place of its own (M51, ADR 0048): your personal connections
 * at /integrations, the chosen organization's at /integrations/organization.
 * The list beside the icon rail is the navigation. The pages themselves are
 * M28's and M30's, unchanged.
 */
import { Navigate } from 'react-router-dom';
import { useWorkspace } from '../shell/workspace.tsx';
import { PersonalIntegrations } from './IntegrationsPage.tsx';
import { OrganizationIntegrations } from './TeamIntegrationsPage.tsx';

export function IntegrationsHubPage({ scope }: { scope: 'personal' | 'organization' }) {
  const { team, loaded } = useWorkspace();
  if (scope === 'organization' && !team) {
    return loaded ? <Navigate to="/integrations" replace /> : <main className="centered">Loading…</main>;
  }
  return (
    <div className="page">
      <main className="column">
        <h1>{scope === 'personal' ? 'Personal integrations' : `${team!.name} integrations`}</h1>
        {scope === 'personal' ? <PersonalIntegrations /> : <OrganizationIntegrations teamId={team!.id} />}
      </main>
    </div>
  );
}
