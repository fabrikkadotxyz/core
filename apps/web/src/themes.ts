/**
 * Applying a theme (M44, ADR 0038).
 *
 * A theme is the chosen pack's theme.css, loaded after the app's own stylesheet.
 * The choice belongs to the account (/api/me/theme). It's also cached on the
 * device, so index.html's inline script can paint it before the app loads.
 * Dusk is the app's own stylesheet, so choosing it loads nothing.
 */
import { useEffect, useState } from 'react';
import { themes as themesApi, type ThemeInfo } from './api.ts';

const KEY = 'fabrikka.theme';
const DEFAULT = 'dusk';
const SYSTEM = { light: 'dusk', dark: 'dusk-night' };
const dark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

/** What the person chose: a theme id, 'system', or null for the default. */
let choice: string | null = readCache()?.choice ?? null;
let offered: ThemeInfo[] | null = null;
const listeners = new Set<() => void>();

function readCache(): { choice: string | null; id: string } | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}

function resolved(): string {
  if (choice === 'system') return dark() ? SYSTEM.dark : SYSTEM.light;
  if (!choice) return DEFAULT;
  // Before the list arrives, trust the choice; afterwards, an id the instance
  // no longer offers falls back to the default.
  if (offered && !offered.some((t) => t.id === choice)) return DEFAULT;
  return choice;
}

function apply(): void {
  const id = resolved();
  const root = document.documentElement;
  let link = document.getElementById('theme-css') as HTMLLinkElement | null;
  if (id === DEFAULT) {
    delete root.dataset.theme;
    link?.remove();
  } else {
    root.dataset.theme = id;
    const href = `/themes/${id}/theme.css`;
    if (!link) {
      link = document.createElement('link');
      link.id = 'theme-css';
      link.rel = 'stylesheet';
    }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    // Last in <head>, so it comes after the app's stylesheet (in development,
    // Vite injects that as <style> tags after the page loads).
    document.head.appendChild(link);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify({ choice, id }));
  } catch {
    // Private windows: the account still remembers the choice.
  }
  listeners.forEach((l) => l());
}

/** Called once at start: apply the cached choice, and follow the system's mode. */
export function startThemes(): void {
  apply();
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => choice === 'system' && apply());
  }
  themesApi
    .list()
    .then((r) => {
      offered = r.themes;
      apply();
    })
    .catch(() => {});
}

/** After sign-in: the account's choice replaces the device's. */
export function syncThemeFromAccount(): void {
  themesApi
    .mine()
    .then((r) => {
      choice = r.theme;
      apply();
    })
    .catch(() => {});
}

/** Choose a theme for this account. Applies at once; saving follows. */
export async function chooseTheme(next: string | null): Promise<void> {
  const before = choice;
  choice = next;
  apply();
  try {
    await themesApi.choose(next);
  } catch (err) {
    choice = before;
    apply();
    throw err;
  }
}

/** The picker's view: what's offered, what's chosen, and what's showing. */
export function useThemes(): { offered: ThemeInfo[] | null; choice: string | null; showing: string } {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    if (!offered) themesApi.list().then((r) => ((offered = r.themes), l())).catch(() => {});
    return () => void listeners.delete(l);
  }, []);
  return { offered, choice, showing: resolved() };
}
