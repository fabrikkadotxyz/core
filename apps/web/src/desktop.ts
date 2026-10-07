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
