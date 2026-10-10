/**
 * Needs you, outside the page (M42, ADR 0037): system notifications, the tab
 * title, and in the desktop app the dock badge and tray dot.
 *
 * Never for the room in front of you. In a browser, notifications need the
 * person's one-time Allow; in the desktop app the operating system asks once.
 */
import { attention as desktopAttention, inDesktopApp, notify as desktopNotify } from './desktop.ts';

const TEXT_KEY = 'fabrikka.notify.text';
const DISMISS_KEY = 'fabrikka.notify.dismissed';

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Per-device conveniences: without storage, the defaults apply.
  }
};

/** Per device: a shared screen may want who and where, not what (default on). */
export const showsText = (): boolean => read(TEXT_KEY) !== 'off';
export const setShowsText = (on: boolean) => write(TEXT_KEY, on ? 'on' : 'off');

/** The room in front of you, if any: `/o/<owner>/s/<session>`. */
export const currentRoomPath = (): string | null => {
  const m = window.location.pathname.match(/^\/o\/[^/]+\/s\/[^/]+/);
  return m ? m[0] : null;
};
const lookingAt = (path: string) => document.visibilityState === 'visible' && document.hasFocus() && currentRoomPath() === path;

/** Browser notifications: whether to offer the banner, and asking. */
export type Permission = 'granted' | 'denied' | 'default' | 'unsupported';
export const permission = (): Permission =>
  inDesktopApp() ? 'granted' : typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
export const bannerDismissed = (): boolean => read(DISMISS_KEY) === '1';
export const dismissBanner = () => write(DISMISS_KEY, '1');
export async function askPermission(): Promise<Permission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.requestPermission();
}

/** One new item: a system notification, unless that room is the one in front of you. */
export function showNotification(n: { title: string; body: string; path: string }, open: (path: string) => void): void {
  if (lookingAt(n.path)) return;
  const body = showsText() ? n.body : '';
  if (inDesktopApp()) {
    void desktopNotify({ title: n.title, body, path: n.path }).catch(() => {});
    return;
  }
  if (permission() !== 'granted') return;
  const note = new Notification(n.title, { body, tag: n.path });
  note.onclick = () => {
    window.focus();
    open(n.path);
    note.close();
  };
}

/** The total, everywhere it shows outside the page: the tab title, the dock and the tray. */
export function showTotal(total: number): void {
  const base = document.title.replace(/^\(\d+\) /, '');
  document.title = total > 0 ? `(${total}) ${base}` : base;
  setFaviconDot(total > 0);
  if (inDesktopApp()) void desktopAttention(total).catch(() => {});
}

let plainIcon: string | null = null;
/** A dot on the tab's icon, drawn over whatever icon the page has. */
function setFaviconDot(on: boolean): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  if (plainIcon === null) plainIcon = link.href || '';
  if (!on) {
    if (plainIcon) link.href = plainIcon;
    else link.removeAttribute('href');
    return;
  }
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  if (!g) return;
  g.fillStyle = '#3d5a80';
  g.beginPath();
  g.roundRect?.(2, 2, 28, 28, 7);
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = 'bold 18px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('M', 16, 17);
  g.fillStyle = '#ee6c4d';
  g.beginPath();
  g.arc(25, 7, 7, 0, Math.PI * 2);
  g.fill();
  link.href = c.toDataURL('image/png');
}
