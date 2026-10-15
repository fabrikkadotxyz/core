# 0045 — A room's output opens in its own window

**Status:** Proposed
**Date:** 2026-10-14
**Builds on:** [ADR 0018](0018-session-screen-is-three-panes.md) (three panes:
the right one is what the session produced), [ADR 0031](0031-the-desktop-app-runs-the-local-host.md)
(the remote page's commands), [ADR 0037](0037-needs-you-is-derived-and-reaches-you-where-you-are.md)
(two more, each limited in Rust).

## Context

The right pane holds what a room has produced: its documents, context, links
and files. People want it on a second screen, beside a terminal, or simply
wider than a rail allows, while the conversation stays where it is. A browser
has tabs for this. The desktop app has one window, and it answers every
new-window request by handing the URL to the system browser (docs/security.md),
where there is no Fabrikka sign-in.

## Decision

- **The output has an address of its own:** `/o/<owner>/s/<session>/output`
  is the right pane alone, full width, live, with the same permissions and the
  same tool calls as in the room. No sidebar, no conversation, no setup.
- **It has tabs of its own.** A strip across the top: *Documents* (the
  overview: documents, links, context, files) and one tab per open document,
  each with a close. Opening a document from the overview adds a tab; the
  room's ↗ adds the document the room has open (`?doc=<id>`). Which tabs are
  open is remembered per room, on the device, separately from the room's own
  pane state: three things in progress are three tabs, and the room keeps
  showing whatever it shows. A deleted document's tab closes itself.
- **In a browser it is a new tab**, opened by one button in the room's header.
- **In the desktop app it is a new window of the app,** not the system browser.
  The web app asks for it with one more command, granted to the configured
  instance's origin like the two of ADR 0037:
  - **`open_output(path)`:** a path *on the instance*, and only one shaped
    `/o/<owner>/s/<session>/output`. Rust joins it to the configured server;
    it never opens a URL the page supplied. One window per output, focused if
    it already exists. The window gets no capability, so the page in it has no
    IPC at all; links to other sites leave for the browser as they do from the
    main window.
- **On macOS it is a tab, not a loose window.** Every window of the app
  carries one tabbing identifier, so the system opens the output as a native
  tab of the main window (the tab bar appears, and the person can drag it out
  into a window of its own, or merge it back). Windows and Linux have no such
  thing; there it stays a window of the app.
- **Old desktop apps** without the command fall back to the browser, as before.

## Consequences

- One more command for the remote page, limited like the others: it can only
  open a page of the instance in a window that looks like the app. The worst a
  compromised instance page could do is open windows of itself.
- Tabs inside a tab: a document already has its own row (edit, history,
  comments). The strip is about *which* document, the row about *which view
  of it*; the two never share a level, so it reads.
- The desktop command's path rule admits exactly one query, `doc=<id>`, and
  an existing output window is pointed at the new address rather than opened
  twice.
- `docs/security.md`: the desktop app row about new windows gains this
  exception.

## Alternatives considered

- **Opening the output in the system browser from the desktop app.** No
  command needed, but the browser has no Fabrikka session, so it starts with a
  sign-in and loses the app's notifications.
- **A pop-out inside the same window.** Not what a second screen needs.
- **One tab or window per document, with the system's tabs.** Cheaper, and
  the same on macOS, but on Windows and Linux three documents would be three
  loose windows, and the owner wanted one place with its documents in it.
