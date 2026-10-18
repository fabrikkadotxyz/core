/**
 * Rendering and composing mentions.
 *
 * Stored content holds `<@participant_id>` markers, so the client resolves names
 * at render time. That is what makes a rename show up in old messages without a
 * refetch. See docs/decisions/0008-mentions-as-stable-markers.md.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { typingAttrs } from './typing.ts';
import type { Mention, Participant } from '@fabrikka/types';

const MARKER = /<@([0-9a-f-]{36})>/gi;

/**
 * Render message content, turning markers into chips.
 *
 * Names come from the live participant list first, so a rename updates every
 * message on screen immediately. `fallback` covers a participant missing from
 * that list.
 */
export function MentionText({
  content,
  participants,
  fallback,
  meParticipantId,
}: {
  content: string;
  participants: Participant[];
  fallback: Mention[];
  meParticipantId?: string;
}) {
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of fallback) map.set(m.participantId, m.displayName);
    // Live list wins: it reflects renames that happened after this message was
    // fetched.
    for (const p of participants) map.set(p.id, p.displayName);
    return map;
  }, [participants, fallback]);

  const parts: React.ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of content.matchAll(MARKER)) {
    const at = match.index;
    if (at > last) parts.push(content.slice(last, at));

    const id = match[1]!.toLowerCase();
    const name = names.get(id);
    if (name) {
      parts.push(
        <span
          key={key++}
          className={id === meParticipantId ? 'mention me' : 'mention'}
        >
          @{name}
        </span>,
      );
    } else {
      // Unknown id: show something inert rather than a raw marker.
      parts.push(
        <span key={key++} className="mention unknown">
          @unknown
        </span>,
      );
    }
    last = at + match[0].length;
  }
  if (last < content.length) parts.push(content.slice(last));

  return <>{parts}</>;
}

/* -------------------------------------------------------------------------- */
/* Composer                                                                   */
/* -------------------------------------------------------------------------- */

/** The `@token` immediately before the caret, if the caret is inside one. */
function activeHandle(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;

  // Must start a token: an '@' after a word character is an email or a version
  // spec, not a mention. Mirrors the server's rule.
  const prev = at > 0 ? before[at - 1]! : ' ';
  if (/[A-Za-z0-9._-]/.test(prev)) return null;

  const query = before.slice(at + 1);
  // A space ends the handle.
  if (/\s/.test(query)) return null;
  return { query, start: at };
}

export interface MentionComposerProps {
  participants: Participant[];
  disabled?: boolean;
  placeholder?: string;
  onSend: (content: string, mentions: string[]) => Promise<void>;
}

export function MentionComposer({
  participants,
  disabled,
  placeholder,
  onSend,
}: MentionComposerProps) {
  const [value, setValue] = useState('');
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [sending, setSending] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  /** Ids picked from the dropdown, so we don't rely on name matching alone. */
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = dismissed ? null : activeHandle(value, caret);

  const matches = useMemo(() => {
    if (!handle) return [];
    const q = handle.query.toLowerCase();
    return participants
      // M58: a person who left is not mentionable; their name on content stays.
      .filter((p) => !p.account && p.displayName.toLowerCase().includes(q))
      .sort((a, b) => {
        // Prefix matches first — typing "ali" should surface "alice" above
        // "not-alice".
        const ap = a.displayName.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.displayName.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp || a.displayName.localeCompare(b.displayName);
      })
      .slice(0, 6);
  }, [handle, participants]);

  useEffect(() => setHighlight(0), [handle?.query]);

  const choose = (p: Participant) => {
    if (!handle) return;
    const next =
      value.slice(0, handle.start) +
      `@${p.displayName} ` +
      value.slice(handle.start + 1 + handle.query.length);

    setValue(next);
    setPicked((prev) => new Set(prev).add(p.id));
    setDismissed(false);

    const pos = handle.start + p.displayName.length + 2;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  const submit = async () => {
    const content = value.trim();
    if (!content || sending) return;

    // Only claim a picked id if its handle survived editing, otherwise deleting
    // the text would leave a phantom mention.
    const mentions = [...picked].filter((id) => {
      const p = participants.find((x) => x.id === id);
      return p && content.includes(`@${p.displayName}`);
    });

    setSending(true);
    try {
      await onSend(content, mentions);
      setValue('');
      setPicked(new Set());
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (handle && matches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h - 1 + matches.length) % matches.length);
        return;
      }
      // Enter picks from the dropdown rather than sending a half-typed handle.
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        choose(matches[highlight]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      void submit();
    }
  };

  const sync = (e: React.SyntheticEvent<HTMLInputElement>) => {
    setCaret(e.currentTarget.selectionStart ?? 0);
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="composer-field">
        {handle && matches.length > 0 && (
          <ul className="mention-menu" role="listbox">
            {matches.map((p, i) => (
              <li
                key={p.id}
                role="option"
                aria-selected={i === highlight}
                className={i === highlight ? 'active' : undefined}
                // mousedown, not click: click fires after blur and loses the caret.
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(p);
                }}
                onMouseEnter={() => setHighlight(i)}
              >
                <span>{p.kind === 'agent' ? '🤖' : '👤'}</span>
                <span>@{p.displayName}</span>
              </li>
            ))}
          </ul>
        )}

        <input
          ref={inputRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setCaret(e.target.selectionStart ?? 0);
            setDismissed(false);
          }}
          onKeyUp={sync}
          onClick={sync}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? 'Message everyone…  @ to mention'}
          autoComplete="off"
          // Spelling and autocorrect follow Appearance → Typing on this device (off by default).
          {...typingAttrs()}
          disabled={disabled}
        />
      </div>

      <button type="submit" disabled={!value.trim() || sending || disabled}>
        ➤
      </button>
    </form>
  );
}
