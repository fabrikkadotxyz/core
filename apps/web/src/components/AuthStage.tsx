/**
 * The stage every page outside the app stands on: sign-in, password reset,
 * setup, an invite. The brand on one side (the mark assembling itself, the
 * name, the line from fabrikka.xyz), the card on the other; stacked on a phone.
 * Themed by tokens like everything else, and Fabrikka's theme.css adds its
 * light (docs/themes.md, "Going further than tokens").
 */
import type { ReactNode } from 'react';
import { Mark } from './Mark.tsx';

export function AuthStage({ children }: { children?: ReactNode }) {
  return (
    <main className="centered auth">
      <aside className="auth-brand" aria-hidden="true">
        <div className="auth-logo">
          <Mark size={56} assemble />
          <span className="auth-wordmark">Fabrikka</span>
        </div>
        <p className="auth-tagline">
          Multiplayer AI.
          <br />
          <em>One room for the whole team.</em>
        </p>
      </aside>
      <section className="auth-panel">{children ?? <p className="hint">Loading…</p>}</section>
    </main>
  );
}

/** The small mono line above a card's title: what kind of page this is. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}
