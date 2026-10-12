/**
 * `@fabrikka/server` as a library (M32, ADR 0029): what a deployment imports.
 * The contract is documented in docs/protocol.md ("Extending the server");
 * anything not exported here is internal and may change in any release.
 */
export { createApp, type CreateAppOptions } from './app.ts';
export type { Extension, Kit, NewAccountResult } from './kit.ts';
export type { AuthEnv, AuthUser } from './auth.ts';
export type { EmailMessage } from './mail.ts';
export type { AccountCheck, MembersListener, NoticeProvider, Refusal, TeamNotice, WriteCheck, WriteContext } from './gates.ts';
export type { CatalogueEntry, CatalogueField, Category } from './connections/catalogue/types.ts';
