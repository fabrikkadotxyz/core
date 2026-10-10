/**
 * When this web app runs inside the Fabrikka desktop app (M34, ADR 0031), it
 * may ask the app for exactly one thing: open its Folders window. No path, no
 * policy — the person chooses there. In a browser there is no app to ask.
 */
type TauriBridge = { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };

const bridge = (): TauriBridge | null =>
  (window as unknown as { __TAURI_INTERNALS__?: TauriBridge }).__TAURI_INTERNALS__ ?? null;

export const inDesktopApp = (): boolean => bridge() !== null;

export async function openFolders(): Promise<void> {
  const b = bridge();
  if (!b) throw new Error('only the Fabrikka desktop app can open its Folders window');
  await b.invoke('open_folders');
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
