/**
 * When this web app runs inside the Fabrikka desktop app (M34, ADR 0031), it
 * may ask the app for three things: open its Folders window (no path, no
 * policy — the person chooses there), and, for M42 (ADR 0037), show a
 * notification and set the dock badge. In a browser there is no app to ask.
 */
type TauriBridge = { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };

const bridge = (): TauriBridge | null =>
  (window as unknown as { __TAURI_INTERNALS__?: TauriBridge }).__TAURI_INTERNALS__ ?? null;

export const inDesktopApp = (): boolean => bridge() !== null;

/** M54 (ADR 0052): `org` preselects the organization in the window's "For"; no path, no policy ever travels. */
export async function openFolders(org?: string): Promise<void> {
  const b = bridge();
  if (!b) throw new Error('only the Fabrikka desktop app can open its Folders window');
  await b.invoke('open_folders', { org: org ?? null });
}

/**
 * M49 (ADR 0045): a room's output in a window of its own. `path` is the output's
 * address on the instance; the app joins it to the configured server and opens
 * one window per output. Outside the app, or in an app without the command, a
 * new browser tab.
 */
export function openOutput(path: string): void {
  const b = bridge();
  const tab = () => window.open(path, '_blank', 'noopener');
  if (!b) {
    tab();
    return;
  }
  b.invoke('open_output', { path }).catch(tab);
}

/** M42: a system notification. The app caps text and rate, and opens only paths on the instance. */
export async function notify(n: { title: string; body: string; path: string }): Promise<void> {
  const b = bridge();
  if (!b) return;
  await b.invoke('notify', n);
}

/** M42: the total that needs you, as the dock badge and the tray dot. */
export async function attention(total: number): Promise<void> {
  const b = bridge();
  if (!b) return;
  await b.invoke('set_attention', { total });
}

/**
 * In the desktop app, a link to another site opens in the person's default
 * browser, in a new tab, instead of replacing Fabrikka in the app's window
 * (docs/security.md, "The desktop app"). A click on such a link becomes a
 * new-window request, which the app hands to the system browser and refuses.
 * Links within the instance, and the integration sign-in (a page change the app
 * makes itself, not a link), are left alone.
 */
export function openOutsideLinksInBrowser(): void {
  if (!inDesktopApp()) return;
  document.addEventListener(
    'click',
    (event) => {
      if (event.defaultPrevented || event.button !== 0) return;
      const link = (event.target as Element | null)?.closest?.('a[href]');
      if (!(link instanceof HTMLAnchorElement)) return;
      const url = new URL(link.href, window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      if (url.origin === window.location.origin) return;
      event.preventDefault();
      window.open(url.href, '_blank', 'noopener');
    },
    // Capture: run before a link's own handlers can navigate the window.
    true,
  );
}
