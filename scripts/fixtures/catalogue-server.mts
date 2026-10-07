/**
 * M18 fixture: a deployment whose catalogue lists fake vendors (the vendors in
 * scripts/fixtures/fake-oauth-mcp.mjs), the way a real catalogue lists GitHub
 * or Atlassian. Used only by scripts/acceptance/m18.mjs, on its own port.
 *
 *   PORT=… FAKE_A=<port> FAKE_B=<port> tsx catalogue-server.mts
 */
import { createApp } from '../../apps/server/src/lib.ts';

const A = `http://localhost:${process.env.FAKE_A}/mcp`;
const B = `http://localhost:${process.env.FAKE_B}/mcp`;

await createApp({
  catalogue: [
    // Dynamic registration, like Atlassian and Grafana Cloud.
    {
      id: 'fakehub', name: 'FakeHub', category: 'code', description: 'A fake code host.', slug: 'fakehub', mcpUrl: A,
      auth: { type: 'oauth', scopes: ['repo'] },
      presets: { read: ['list_issues', 'whoami'], write: ['merge_pull_request'] },
    },
    // No registration: a pre-registered client from the environment, like GitHub.
    {
      id: 'fakepre', name: 'FakePre', category: 'code', description: 'Needs a pre-registered client.', slug: 'fakepre', mcpUrl: B,
      auth: { type: 'oauth', client: { idEnv: 'FAKE_PRE_CLIENT_ID', secretEnv: 'FAKE_PRE_CLIENT_SECRET' } },
    },
    // Not configured on this instance: must not be offered.
    {
      id: 'fakeunset', name: 'FakeUnset', category: 'code', description: 'Its client is not configured.', slug: 'fakeunset', mcpUrl: B,
      auth: { type: 'oauth', client: { idEnv: 'FAKE_UNSET_CLIENT_ID', secretEnv: 'FAKE_UNSET_CLIENT_SECRET' } },
    },
    // Two entries, one connection, like Jira and Confluence.
    { id: 'faketracker', name: 'FakeTracker', category: 'issues', description: 'Tickets.', slug: 'fakesuite', connectionName: 'FakeSuite', mcpUrl: A, auth: { type: 'oauth' } },
    { id: 'fakewiki', name: 'FakeWiki', category: 'docs', description: 'Pages.', slug: 'fakesuite', connectionName: 'FakeSuite', mcpUrl: A, auth: { type: 'oauth' } },
    // A field sent as a header, like Grafana's stack.
    {
      id: 'fakegraf', name: 'FakeGraf', category: 'observability', description: 'Dashboards.', slug: 'fakegraf', mcpUrl: A,
      auth: { type: 'oauth' },
      fields: [{ key: 'stack', label: 'Stack URL', header: 'X-Fake-Stack', required: true, kind: 'https-url', placeholder: 'https://you.example.net' }],
    },
  ],
}).start(Number(process.env.PORT));
