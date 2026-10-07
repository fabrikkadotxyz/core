/**
 * The app's own selector (M36): replaces native <select>, which renders as the
 * operating system's pop-up button — grey and dated, and inside the desktop app
 * it looks like another program.
 *
 * The listbox pattern, keyboard-first: a button shows the current choice; ↑ ↓
 * Home End move, Enter or Space chooses, Escape closes, typing jumps to an
 * option. Opens upward when there's no room below. `tone="sidebar"` draws it for
 * the dark sidebar.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** A second, quieter line under the label. */
  description?: string;
  /** Something before the label: an initial, an icon. */
  leading?: ReactNode;
}

interface Props<T extends string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** The accessible name — there's no visible <label> for most of these. */
  label: string;
  tone?: 'page' | 'sidebar';
  className?: string;
  disabled?: boolean;
}

export function Select<T extends string>({ value, options, onChange, label, tone = 'page', className, disabled }: Props<T>) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [upward, setUpward] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const typed = useRef({ text: '', at: 0 });

  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const current = options[selectedIndex];

  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const choose = (index: number) => {
    const o = options[index];
    if (o && o.value !== value) onChange(o.value);
    close();
  };

  // Close on a click anywhere else.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  // Open upward when the list wouldn't fit below.
  useLayoutEffect(() => {
    if (!open || !root.current || !list.current) return;
    const below = window.innerHeight - root.current.getBoundingClientRect().bottom;
    setUpward(below < list.current.offsetHeight + 12 && root.current.getBoundingClientRect().top > below);
    list.current.focus();
  }, [open]);

  // Keep the active option in view while moving through a long list.
  useEffect(() => {
    if (open) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const typeahead = (key: string) => {
    const now = Date.now();
    typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : '') + key.toLowerCase(), at: now };
    const from = typed.current.text.length === 1 ? active + 1 : active;
    for (let i = 0; i < options.length; i++) {
      const j = (from + i) % options.length;
      if (options[j]!.label.toLowerCase().startsWith(typed.current.text)) return setActive(j);
    }
  };

  const onButtonKey = (e: React.KeyboardEvent) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      openAt(e.key === 'ArrowUp' ? Math.max(0, selectedIndex - 1) : selectedIndex);
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const last = options.length - 1;
    if (e.key === 'ArrowDown') setActive((a) => Math.min(last, a + 1));
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(last);
    else if (e.key === 'Enter' || e.key === ' ') choose(active);
    else if (e.key === 'Escape' || e.key === 'Tab') return close(e.key === 'Escape');
    else if (e.key.length === 1 && /\S/.test(e.key)) typeahead(e.key);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={root} className={`select select-${tone}${className ? ` ${className}` : ''}`}>
      <button
        ref={button}
        type="button"
        className="select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`${label}: ${current?.label ?? ''}`}
        disabled={disabled}
        onClick={() => (open ? close() : openAt(selectedIndex))}
        onKeyDown={onButtonKey}
      >
        {current?.leading && <span className="select-leading">{current.leading}</span>}
        <span className="select-value">{current?.label}</span>
        <svg className="select-chevron" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul
          ref={list}
          id={`${id}-list`}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={`${id}-${active}`}
          className={`select-list${upward ? ' up' : ''}`}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-${i}`}
              data-index={i}
              role="option"
              aria-selected={o.value === value}
              className={`select-option${i === active ? ' active' : ''}${o.value === value ? ' chosen' : ''}`}
              onPointerEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              {o.leading && <span className="select-leading">{o.leading}</span>}
              <span className="select-text">
                <span className="select-label">{o.label}</span>
                {o.description && <span className="select-description">{o.description}</span>}
              </span>
              {o.value === value && (
                <svg className="select-check" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A team's initial, in a small rounded square — the chat-app workspace badge. */
export function TeamInitial({ name }: { name: string }) {
  return <span className="team-initial">{(name.trim()[0] ?? '?').toUpperCase()}</span>;
}
