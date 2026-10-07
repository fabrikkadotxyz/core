/**
 * A catalogue entry (M18, ADR 0024): one vendor's own MCP server, offered under
 * a category. Data, not code — adding a vendor is one file plus one registry line.
 */
export type Category = 'code' | 'issues' | 'observability' | 'docs';

export const CATEGORY_NAMES: Record<Category, string> = {
  code: 'Code host',
  issues: 'Issue tracker',
  observability: 'Observability',
  docs: 'Docs',
};

/** Something the person fills in when connecting, sent as a header on every call. */
export interface CatalogueField {
  key: string;
  label: string;
  placeholder?: string;
  /** The request header it's sent as (Grafana: X-Grafana-URL). */
  header: string;
  required: boolean;
  /** An https URL, for now the only kind of field any entry needs. */
  kind: 'https-url';
}

export interface CatalogueEntry {
  id: string;
  name: string;
  category: Category;
  /** One line: what connecting it lets agents do. */
  description: string;
  /**
   * The connection's slug, which grants key on. Entries backed by one connection
   * share it (Jira and Confluence: "atlassian").
   */
  slug: string;
  /** What the shared connection is called, when it's not the entry's own name. */
  connectionName?: string;
  mcpUrl: string;
  auth: {
    type: 'oauth';
    scopes?: string[];
    /**
     * A pre-registered client, for vendors with no dynamic registration
     * (GitHub). Read from the environment; absent there, the entry isn't offered.
     */
    client?: { idEnv: string; secretEnv: string };
  };
  fields?: CatalogueField[];
  /** Grant presets: upstream tool names, from a real connection's tool list. */
  presets?: { read: string[]; write: string[] };
}
