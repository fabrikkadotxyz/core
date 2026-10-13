/**
 * Onboarding's state (M47), shared by the shell (welcome yet?) and the home
 * page's Get started card. Fetched once per sign-in, refreshed on demand.
 */
import { useCallback, useEffect, useState } from 'react';
import { onboarding, type GettingStarted } from './api.ts';

let current: GettingStarted | null = null;
let failed = false;
let loading: Promise<GettingStarted> | null = null;
const listeners = new Set<() => void>();

function publish(g: GettingStarted | null, didFail = false) {
  current = g;
  failed = didFail;
  listeners.forEach((l) => l());
}

export function refreshOnboarding(): Promise<GettingStarted> {
  loading ??= onboarding
    .get()
    .then((g) => {
      publish(g);
      return g;
    })
    .catch((err) => {
      if (!current) publish(null, true);
      throw err;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** After the welcome's Continue, without waiting for a refetch. */
export function markWelcomedLocally(): void {
  if (current) publish({ ...current, welcomed: true });
}

/** Forget it on sign-out, so the next account starts fresh. */
export function resetOnboarding(): void {
  publish(null);
}

export function useOnboarding(): { state: GettingStarted | null; failed: boolean; refresh: () => Promise<GettingStarted> } {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    if (!current) refreshOnboarding().catch(() => {});
    return () => void listeners.delete(l);
  }, []);
  return { state: current, failed, refresh: useCallback(() => refreshOnboarding(), []) };
}
