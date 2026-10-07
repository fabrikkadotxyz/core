/**
 * The core server's own entry point: the app with no extensions, listening on
 * PORT. A deployment that extends the core imports `createApp` from
 * `@fabrikka/server` instead (M32, ADR 0029).
 */
import { createApp } from './app.ts';

await createApp().start();
