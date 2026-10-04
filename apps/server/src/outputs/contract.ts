/**
 * The contract an output kind implements. See ADR 0023.
 *
 * Two layers: a **store** owns where content lives and how an edit is applied
 * (the Yjs store for native kinds; a Google store for `gdoc`); a **kind** owns
 * what the content means — its catalogue entry, file model, template and hooks.
 * Core (`core.ts`) routes every call through these and names no kind itself.
 */
import type { Hono } from 'hono';
import type { Database } from '@fabrikka/db';
import type { outputs } from '@fabrikka/db';
import type { AnchoredEdit } from '../output-text.ts';

export type OutputRow = typeof outputs.$inferSelect;

export type EditRequest =
  | { kind: 'edits'; edits: AnchoredEdit[] }
  | { kind: 'append'; text: string }
  | { kind: 'replace'; content: string; ifVersion: number };

export interface EditResult {
  version: number;
  applied: number;
  file: string;
}

/** What a sync socket needs from the server's WebSocket. */
export interface SyncSocket {
  send(data: string | Uint8Array): void;
  close(): void;
}

export interface SocketHandlers {
  onMessage: (data: ArrayBuffer | string) => void;
  onClose: () => void;
}

/**
 * What a kind's hooks may see and do. Deliberately narrow: no database, no hub.
 * The only way to change the content is `edit`, which goes through the same
 * attributed path as every other editor — a kind cannot bypass the changes log.
 */
export interface KindContext {
  readonly outputId: string;
  readonly sessionId: string;
  readonly version: number;
  /** Browsers with this output open right now. */
  readonly viewers: number;
  /** Current text of every file. */
  files(): Map<string, string>;
  /** The kind's own data (`outputs.kind_data`). Core never reads it. */
  readonly kindData: Record<string, unknown>;
  setKindData(patch: Record<string, unknown>): Promise<void>;
  edit(participantId: string, request: EditRequest, file?: string): Promise<EditResult>;
}

/** Where an output's content lives, and how an edit is applied to it. */
export interface OutputStore {
  /** The persisted state for a new output holding these files. */
  initialState(files: Record<string, string>): Uint8Array | null;
  /** File names and current version, for the list. Must not load anything heavy. */
  describe(row: OutputRow): { files: string[]; version: number };
  /** A context over a live output, loading it if needed. */
  open(db: Database, row: OutputRow, kind: OutputKindModule): Promise<KindContext>;
  edit(
    db: Database,
    row: OutputRow,
    kind: OutputKindModule,
    opts: { participantId: string; file: string; request: EditRequest },
  ): Promise<EditResult>;
  addFile(db: Database, row: OutputRow, kind: OutputKindModule, opts: { participantId: string; path: string }): Promise<void>;
  removeFile(db: Database, row: OutputRow, kind: OutputKindModule, opts: { participantId: string; path: string }): Promise<void>;
  /** Attach a viewer's browser. Membership was checked by the caller. */
  attach(
    db: Database,
    row: OutputRow,
    kind: OutputKindModule,
    /** `readOnly` (M22): a viewer — answer their sync requests, drop their updates. */
    opts: { participantId: string | null; ws: SyncSocket; readOnly?: boolean },
  ): Promise<SocketHandlers>;
  /** The output is being deleted: drop anything held in memory, close viewers. */
  evict(outputId: string): void;
}

/** Resolves the session for the caller, or null — which must be a 404. */
export type MemberResolver = (c: any) => Promise<{ id: string } | null>;

/**
 * How a kind's session routes check access. `member` admits members only;
 * `viewer` also admits viewers (M22: teammates of a team-visible session, and
 * guests). Use `viewer` only for routes that read — never for one that writes.
 */
export interface Resolvers {
  member: MemberResolver;
  viewer: MemberResolver;
}

/** A kind's own HTTP routes. */
export interface KindRoutes {
  /** Unauthenticated routes, e.g. static assets a browser fetches without a session. */
  public?: (app: Hono<any>) => void;
  /** Routes under /api/o/:owner/s/:session. Resolve first; null means 404. */
  session?: (routes: Hono<any>, resolve: Resolvers) => void;
}

export interface OutputKindModule {
  /** Stable id: stored in `outputs.kind`, sent to agents. Never rename one. */
  id: string;
  name: string;
  description: string;
  icon: string;
  /** What a new one is called before anyone names it. */
  defaultName: string;
  /** What `read_output` reports as `format`. */
  format: string;
  multiFile: boolean;
  mainFile: string;
  /** Multi-file kinds: which extra file names are allowed, and how to say so. */
  files?: {
    accepts(path: string): boolean;
    /** Completes "use …": shown when an agent's path is refused. */
    rule: string;
    /** Completes "use a name like …": shown when a browser's path is refused. */
    example: string;
  };
  /** False makes the kind absent from the catalogue — absent, not broken. */
  available(): boolean;
  store: OutputStore;
  template(name: string): Record<string, string>;

  onRenamed?(ctx: KindContext, opts: { before: string; after: string; participantId: string }): Promise<void>;
  /** Extra fields for `read_output`, merged into the result. */
  readExtras?(ctx: KindContext): Record<string, unknown>;
  /** A JSON text frame from a viewer's socket. */
  onClientMessage?(ctx: KindContext, msg: Record<string, unknown>): Promise<void>;
  routes?: KindRoutes;
  /** One sentence appended to the `edit_output` tool description. */
  agentHint?: string;
}
