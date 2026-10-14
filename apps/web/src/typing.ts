/**
 * Typing on this device (M44 addendum, 2026-10-14): whether the system checks
 * spelling and autocorrects what you type in a room. **Off by default.** People
 * type identifiers, paths, commands and agents' names into the composer, and an
 * autocorrected `useEffect` or a capitalised `git` is a wrong message. In the
 * desktop app (WKWebView on macOS) the system autocorrects unless the page says
 * not to, so the page says so.
 *
 * Per device, like notifications' text (`notify.ts`): a laptop that wants
 * spelling help and a shared screen that doesn't are different devices.
 */
const KEY = 'fabrikka.typing.spelling';

const read = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/** Whether spelling and autocorrect are on for this device (default off). */
export const spellingOn = (): boolean => read() === 'on';
export const setSpellingOn = (on: boolean) => {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Per-device conveniences: without storage, the default (off) applies.
  }
};

/**
 * The attributes a free-text field in a room spreads: `spellCheck` and the
 * system's `autocorrect`, `autocapitalize` (iOS, macOS) follow the setting.
 */
export function typingAttrs(): { spellCheck: boolean; autoCorrect: 'on' | 'off'; autoCapitalize: 'sentences' | 'off' } {
  const on = spellingOn();
  return { spellCheck: on, autoCorrect: on ? 'on' : 'off', autoCapitalize: on ? 'sentences' : 'off' };
}
