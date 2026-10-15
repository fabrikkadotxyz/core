/**
 * A catalogue entry (M18, ADR 0024): one vendor's own MCP server, offered under
 * a category. Data, not code — adding a vendor is one file plus one registry line.
 */
export type Category = 'code' | 'issues' | 'observability' | 'docs' | 'email' | 'calendar';

export const CATEGORY_NAMES: Record<Category, string> = {
  code: 'Code host',
  issues: 'Issue tracker',
  observability: 'Observability',
  docs: 'Docs',
  email: 'Email',
  calendar: 'Calendar',
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
    /**
     * Extra parameters on the authorization request (ADR 0046): Google issues
     * a refresh token only with access_type=offline and prompt=consent.
     */
    authorizeParams?: Record<string, string>;
  };
  fields?: CatalogueField[];
  /** Grant presets: upstream tool names, from a real connection's tool list. */
  presets?: { read: string[]; write: string[] };
  /** Extra words the search box matches: "tickets" finds Jira. */
  keywords?: string[];
  /**
   * The vendor's mark: one SVG path in a 24×24 box and its brand colour, from
   * Simple Icons (CC0) at the version named beside it. Data, never markup: the
   * server refuses anything but path commands and a hex colour (`safeLogo`).
   */
  logo?: VendorLogo;
}

export interface VendorLogo {
  path: string;
  color: string;
}

/** A logo the page can draw, or null: path commands and numbers only, and a hex colour. */
export function safeLogo(logo: VendorLogo | undefined): VendorLogo | null {
  if (!logo) return null;
  if (!/^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]{1,8000}$/.test(logo.path)) return null;
  if (!/^#[0-9a-fA-F]{6}$/.test(logo.color)) return null;
  return logo;
}
