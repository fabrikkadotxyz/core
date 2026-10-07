/**
 * This client's version, stamped in by build.mjs (M33, ADR 0030). The same
 * string is in dist/version.json, which the server reads for its manifest, so
 * "update available" is an exact comparison. Running from source, it's "dev".
 */
declare const __FABRIKKA_VERSION__: string | undefined;

export const VERSION: string = typeof __FABRIKKA_VERSION__ === 'string' ? __FABRIKKA_VERSION__ : 'dev';
