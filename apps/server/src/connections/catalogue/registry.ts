/**
 * The catalogue (M18, ADR 0024). A vendor is listed only once it has been
 * connected for real — "verified, not documented"; an unverified vendor is
 * absent, not broken. Add one file in this folder and one line here.
 *
 * A deployment can add its own entries through createApp({ catalogue }) — the
 * acceptance check uses that for a local fake vendor.
 */
import { confluence, jira } from './atlassian.ts';
import { clickup } from './clickup.ts';
import { github } from './github.ts';
import { gitlab } from './gitlab.ts';
import { googleCalendar } from './google-calendar.ts';
import { googleDocs } from './google-docs.ts';
import { googleDrive } from './google-drive.ts';
import { googleGmail } from './google-gmail.ts';
import { googleSheets } from './google-sheets.ts';
import { grafana } from './grafana.ts';
import { linear } from './linear.ts';
import { notion } from './notion.ts';
import { sentry } from './sentry.ts';
import type { CatalogueEntry } from './types.ts';

// One line per vendor, added once it has been connected for real. Grafana Cloud
// and the five Google products were listed on the owner's decision (2026-10-15)
// before a real connection: their presets are filled in from the first one.
const BUILT_IN: CatalogueEntry[] = [
  github, jira, confluence, linear, sentry, notion, clickup, gitlab,
  grafana, googleCalendar, googleDrive, googleSheets, googleDocs, googleGmail,
];

/**
 * Written from a real probe, not yet connected for real. Offered only where
 * FABRIKKA_PREPARED_VENDORS names them, so the owner can connect one and
 * verify it before it joins BUILT_IN (docs/operations.md, "A prepared vendor").
 */
const PREPARED: CatalogueEntry[] = [];

function preparedOffered(): CatalogueEntry[] {
  const ids = (process.env.FABRIKKA_PREPARED_VENDORS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids) {
    if (!PREPARED.some((e) => e.id === id) && !warned.has(id)) {
      warned.add(id);
      console.warn(`[catalogue] FABRIKKA_PREPARED_VENDORS names "${id}", which isn't a prepared vendor; ignored`);
    }
  }
  return PREPARED.filter((e) => ids.includes(e.id));
}
const warned = new Set<string>();

/** Whether an entry is offered here only as a preview, not yet verified. */
export function isPreview(entry: CatalogueEntry): boolean {
  return PREPARED.includes(entry);
}

let extra: CatalogueEntry[] = [];

/** Called once by createApp. */
export function setExtraEntries(entries: CatalogueEntry[]): void {
  extra = entries;
}

/** Every entry this instance could offer, configured or not. */
export function allEntries(): CatalogueEntry[] {
  return [...BUILT_IN, ...preparedOffered(), ...extra];
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
