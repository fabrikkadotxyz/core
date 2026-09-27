/**
 * The upstream session endpoint, as an MCP client.
 *
 * The bridge holds NO tool logic: it lists the tools the session exposes and
 * re-exposes each one, forwarding calls verbatim. So it gains M7's artifact tools
 * and M8's aggregated tools with no change here, and it cannot drift from lane A
 * because it *is* lane A behind a different transport.
 *
 * This is the v2 client talking to our own v2 HTTP endpoint, while the channel
 * side is a v1 stdio server. Two SDK generations, each for a local reason
 * (ADR 0005, ADR 0010).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export interface UpstreamTool {
  name: string;
  description?: string;
  inputSchema: unknown;
}

export class Upstream {
  private client: Client | undefined;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async connect(): Promise<void> {
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
    });
    const client = new Client({ name: 'fabrikka-bridge', version: '0.0.0' });
    await client.connect(transport);
    this.client = client;
  }

  async listTools(): Promise<UpstreamTool[]> {
    if (!this.client) throw new Error('upstream not connected');
    const { tools } = await this.client.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  /** Forward a tool call and return its raw result content. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error('upstream not connected');
    return this.client.callTool({ name, arguments: args });
  }

  /** Convenience for the bridge's own bookkeeping. */
  async whoami(): Promise<{ display_name: string; session: string } | null> {
    try {
      const result = (await this.callTool('whoami', {})) as {
        content?: { type: string; text?: string }[];
      };
      const text = result.content?.[0]?.text;
      if (!text) return null;
      const parsed = JSON.parse(text) as {
        participant?: { display_name?: string };
        session?: { id?: string };
      };
      return {
        display_name: parsed.participant?.display_name ?? 'unknown',
        session: parsed.session?.id ?? 'unknown',
      };
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
  }
}
