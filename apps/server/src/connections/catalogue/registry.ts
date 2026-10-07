/**
 * The catalogue (M18, ADR 0024). A vendor is listed only once it has been
 * connected for real — "verified, not documented"; an unverified vendor is
 * absent, not broken. Add one file in this folder and one line here.
 *
 * A deployment can add its own entries through createApp({ catalogue }) — the
 * acceptance check uses that for a local fake vendor.
 */
import { github } from './github.ts';
import type { CatalogueEntry } from './types.ts';

// One line per vendor, added once it has been connected for real.
const BUILT_IN: CatalogueEntry[] = [github];

let extra: CatalogueEntry[] = [];

/** Called once by createApp. */
export function setExtraEntries(entries: CatalogueEntry[]): void {
  extra = entries;
}

/** Every entry this instance could offer, configured or not. */
export function allEntries(): CatalogueEntry[] {
  return [...BUILT_IN, ...extra];
}

/** An entry needing a pre-registered client is offered only once the instance has one. */
export function isConfigured(entry: CatalogueEntry): boolean {
  const c = entry.auth.client;
  return !c || (!!process.env[c.idEnv] && !!process.env[c.secretEnv]);
}

export function offeredEntries(): CatalogueEntry[] {
  return allEntries().filter(isConfigured);
}

/** Entries this instance can't offer yet, and the settings each one is missing. */
export function unconfiguredEntries(): { entry: CatalogueEntry; missing: string[] }[] {
  return allEntries()
    .filter((e) => !isConfigured(e))
    .map((e) => ({ entry: e, missing: [e.auth.client!.idEnv, e.auth.client!.secretEnv].filter((k) => !process.env[k]) }));
}

export function findEntry(id: string): CatalogueEntry | undefined {
  return allEntries().find((e) => e.id === id);
}
