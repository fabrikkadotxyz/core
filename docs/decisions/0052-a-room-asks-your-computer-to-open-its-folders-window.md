# 0052 — A room asks your computer to open its Folders window

**Status:** Proposed
**Date:** 2026-10-16
**Extends:** [ADR 0027](0027-a-paired-local-host-runs-agents-in-folders-granted-on-the-machine.md)
(folders are granted on the machine, never from the web) and
[ADR 0031](0031-the-desktop-app-runs-the-local-host.md) (the app's Folders
window is the one place a folder is chosen). Does not loosen either.

## Context

*Add my agent* in a room lists the folders your computers offer for the
room's organization. When there is none, it says so and tells you where to
go: in the desktop app, a button opens the Folders window; in a browser, a
sentence says *on that computer: the menu-bar icon → Folders…*. The owner,
2026-10-16: *there should be an easy way to add a new folder when adding an
agent*; from that spot, a modal to add a computer or a folder, scoped to the
organization.

The rule that constrains this: **the server, and any web page, never names
a path or a policy.** A folder is chosen in the app's own window, with the
operating system's picker, on the machine. That is what makes a compromised
server unable to grant itself a folder.

## Decision

**1. The room can ask a computer to open its Folders window, with the
organization preselected.** Nothing else travels: no path, no policy. The
person still chooses the folder in the native picker and its policy in the
window. An organization the host does not know is ignored.

- From the desktop app, the web page calls the app directly, as before, now
  with the organization to preselect: `open_folders(org?)`.
- From a browser, the page asks the server: `POST /api/devices/:id/open-folders`
  `{ teamId }`, for a computer of yours that is online. The server sends the
  host one frame, `{ type: 'open_folders', org }`. The host under the
  desktop app pushes `{ event: 'open_folders', org }` to the app, which
  shows the window with *For* set. A host run from a terminal has no window
  and says, on its own output, to open the Folders page it printed.
- A computer that is offline is refused (409); someone else's computer is a
  404, like every device route.

**2. Add my agent gets one dialog, "Folders", for the room's organization.**
It lists your computers, each with the folders it offers for this
organization and an **Add a folder…** button when it is online, and
**Connect another computer** with the one-line install command (M33). The
picker behind it refreshes while the dialog is open, so a folder granted on
the machine appears and is selected without a reload.

**3. The threat model is unchanged.** A server that abuses this can make a
window appear on your screen. It cannot choose a folder, a policy or a
machine you did not pair, and the window shows which organization it asks
for.

## Consequences

- With a paired computer and no folder yet: **Setup → Agents → Add my agent →
  Add a folder… → (the app's picker) → Add**: the room is one click from the
  window, in the browser as in the app.
- Two protocol additions, both documented in `docs/protocol.md`: the
  server-to-host frame `open_folders` and the stdio event of the same name.
  Hosts that do not know the frame ignore it, as they ignore any unknown
  frame.
- The desktop capability for the instance's pages, `open_folders`, now takes
  one optional argument, the organization. The M34 check that pinned "no
  argument" pins "no path, no policy" instead.

## Alternatives considered

**Let the web page grant a folder by path.** Rejected by ADR 0027 and ADR
0031: that is exactly the capability a compromised server must not have.

**A deep link (`fabrikka://folders`) the browser opens.** Would work only
on the computer the browser runs on, needs a URL scheme registered by the
app, and tells the app nothing a server frame cannot. The host is already
connected; asking through it reaches any of your computers.

**Keep the sentence.** It is where the owner stopped.
