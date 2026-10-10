# 0037 — "Needs you" is derived from the record, and reaches you where you are

**Status:** Proposed
**Date:** 2026-10-10
**Builds on:** M24 (read positions, *Waiting for you*), M29 (unread chats),
M6 (the turn budget pauses a session), [ADR 0031](0031-the-desktop-app-runs-the-local-host.md)
(what the remote page may ask of the desktop app).

## Context

A person works in several rooms at once: a personal one, one with some
colleagues, one with others. Agents work in all of them while the person is
looking at one. Today:

- **The sidebar bolds a room with unread messages** and gives it a dot. That
  says "something was said", not "something needs you", and every message counts
  the same, including an agent's routine progress.
- **The sidebar updates only when the window regains focus.** The rooms you
  aren't looking at don't change in front of you.
- ***Waiting for you* (M24)** lists mentions of you across rooms, but only on
  the home page, and only when you open it.
- **Nothing reaches you outside the page:** no browser tab count, no system
  notification, no dock badge.

So an agent that hands work to you, or stops and waits, waits unseen until you
happen to look. That breaks *hand it off*, one of the three verbs MVP is built
around (`docs/mvp.md`).

## Decision

**A room "needs you" when, since you last looked at it, something happened
that is addressed to you. It is derived from the record, like unread, and never
stored. It's shown as a number on the room, pushed live to every page and app
you have open, and turned into a system notification when you're not looking at
that room.**

### What needs you

Since your read position in that room:

- **a message that mentions you,** from a person or an agent. An agent's
  handoff (M24) is exactly this;
- **in a direct chat, any message** from the other person;
- **an agent you own finished, failed or was stopped** in that room, while you
  weren't looking at it;
- **the room paused on its turn budget** (M6), for the people who can resume it.

Each is one item. The room's number is how many there are. Nothing else
notifies: not an agent's activity while it works, not a message you wrote, not
a context edit.

### Unread and needs-you are two levels

- **Unread:** the room's name is **bold**. Unchanged from M29.
- **Needs you:** bold **and a number** in the attention colour (the Burnt Peach
  gradient), in place of the dot.
- **Per room, three settings**, from the room's header (one click to open, one
  to choose):
  - **Everything:** every message from someone else counts as needing you.
  - **What needs me** (the default for rooms and team chats).
  - **Nothing:** the room is muted. It's never bold and never numbered, but
    mentions of you still reach *Waiting for you*.
  - Direct chats default to *Everything*.

### Live, through one stream per person

- **A per-person WebSocket, `/api/me/stream`,** next to the per-room ones.
  It carries `{ sessionId, unread, needsYou }` whenever either changes for that
  person, plus a `notify` event for each new item (below).
- **The sidebar, the team switcher and the tab title** follow it. They no
  longer wait for focus.
- **The stream obeys the same visibility rules** as the room list: it never
  names a room the person can't see.

### Where it reaches you

| Where | What you see |
| --- | --- |
| **Sidebar** | The room bold, with its number |
| **Team switcher** | A dot on another team when one of its rooms needs you |
| **Browser tab** | `(3) Fabrikka`: the total, and a dot on the icon |
| **Browser, notifications on** | A system notification per item, when that room isn't the one in front of you |
| **Desktop app** | The same notification, a dock badge with the total, and a dot on the tray icon |
| **Email** | Unchanged: *Waiting for you* can be mailed when a notifier is configured (M24, ADR 0007) |

- **Turning browser notifications on is one click** on a banner the first time
  something needs you, then the browser's own *Allow*. The desktop app asks
  once, through the operating system.
- **A notification says who and where:** *"Alice mentioned you in Checkout
  500s"*, then the first line of the message. A per-device setting, **Show
  message text in notifications**, can hide that line, for screens other people
  see.
- **Clicking a notification opens that room:** one click.

### What the remote page may ask of the desktop app

ADR 0031 grants the instance's pages exactly one command, `open_folders`. This
adds two, granted to the same exact origin and nothing else:

- **`set_attention(total)`:** a number, shown as the dock badge and the tray
  dot. Rust clamps it to 0–999.
- **`notify({ title, body, path })`:** short text, and a path *on the
  instance*.
  - Rust rejects a path that isn't a relative path starting with `/`, so a click
    can only open the instance itself.
  - Rust caps the text length, and the rate: one per room per 10 seconds, 30 a
    minute.

Neither can read anything, start anything, or reach the host. The worst a
compromised instance page could do with them is show misleading notifications,
which it could already do as a page in a browser.

## Consequences

- **Agents can hand work to you and you'll know.** S7's "her *Waiting for you*
  has it in the morning" also becomes a notification while she's working
  elsewhere.
- **No new table for attention.** It's a query over messages, mentions, runs and
  read positions, like unread. The per-room setting is one new column on
  `session_reads` (`docs/data-model.md`).
- **The per-person stream is new load:** one socket per open page. It sends
  counts and short notification text, never whole rooms.
- **Notification text leaves the page** for the operating system's notification
  centre. The per-device setting exists for that, and `docs/security.md`
  records it.
- **ADR 0031's "exactly one command" becomes three.** The test that asserts the
  remote window can't reach a host command stays, and gains a check that these
  two can't open a URL off the instance.
- **"Resuming offline agents"** (roadmap, *Later*) gets its nudge for free when
  it's built: a missed mention is already an item.

## Alternatives considered

- **Count every unread message.** That's what the dot does today. A room where
  two agents work for an hour would show 80, and the number would stop meaning
  anything.
- **A stored notifications table, with read and unread per notification.** It
  can drift from the record (a message deleted, a run retried), and it's one
  more thing to clear. A difference from your read position can't drift.
- **Web notifications only, also in the desktop app.** The app's web view
  doesn't reliably support the browser Notification API across platforms, and it
  can't set a dock badge. Two narrow commands are smaller than a plugin the page
  drives freely.
- **Push notifications to a phone.** Needs a mobile app or a push service, and
  mobile is explicitly not MVP.
