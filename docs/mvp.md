# The road to MVP

**Written:** 2026-10-10. This supersedes the *MVP acceptance* section of
`docs/roadmap.md`, which was written for M8 and assumed every participant is a
developer with a terminal.

## What the MVP has to prove

> A team, and the AI agents they already have, work one problem together in a
> shared, live room. Anyone can watch an agent work, redirect it, and hand it
> off, and nobody carries context between them by hand.

It's multiplayer AI: what Google Docs did for documents and Figma for design,
done for agents. Think *Slack for problems, not conversations*. A room exists to
produce an outcome (a fix, a paper, a proposal) and leaves a record behind.

**The test for every feature:** does it help someone **watch** an agent work,
**redirect** it, or **hand it off**? If not, it isn't MVP.

### For whom

| Who | What they bring | How their agent joins |
| --- | --- | --- |
| Developers | Claude Code, Codex, their repos and tools | Desktop app or terminal (lanes A and B, spawn), as today |
| Students and academics | Claude or ChatGPT in the browser | **A connector in their chat app**, with no terminal (M38) |
| Office workers | The same | The same |

The second and third rows don't work today. Every agent path assumes a
terminal. **Closing that gap is the largest piece of MVP work.**

### Where it runs

- **Self-hosted, free, forever.** One click deploys it to a cloud account the
  person owns, or `docker compose up` runs it on any server.
- **Or hosted,** for people who don't want to run it: the same code
  ([ADR 0029](decisions/0029-the-core-is-a-library-a-deployment-extends-it.md)),
  with anything a deployment adds kept in an extension, never in the core.
- **License:** [ADR 0034](decisions/0034-license-agpl-3.0.md) (Accepted),
  **AGPL-3.0**.

## Where we are (2026-10-10)

| State | Milestones |
| --- | --- |
| Tagged | M0–M13, M21–M23, M25, M27–M33 |
| Built, waiting on the manual test and a tag | M19, M20, M24, M34–M37 |
| In progress | M18 (connections) |
| Specified, not built | M14 (Google Docs), M15 (steering), M16 (more agents), M17 (first run), M26 (lend your agent) |

## The plan

Phases are sequential, and so are milestones within a phase (`CLAUDE.md`). Each
new milestone gets its full spec and manual test in `docs/roadmap.md` before
it's built. The outlines below say what it must deliver.

### Phase 0: close what's open

No new features until this is done.

1. **Manual tests, then tags:** M19, M20 and M24, then M34–M37. Then accept ADRs
   0031–0033.
2. **Finish M18 at the S1 debugging story, no further.**
   - GitHub, once the instance has its OAuth App.
   - Atlassian (Jira and Confluence) with real grant presets.
   - **One** of Sentry or Grafana Cloud.
   - Every other vendor waits until after MVP. A custom connection covers the
     rest.

### Phase 1: the verbs

3. **M15: Steering.** *Redirect it.* As specified: stop and resume, and the UI
   says which ([ADR 0016](decisions/0016-steering-is-stop-and-resume.md)).
4. **M17: First run.** As specified: from an invite link to your own agent in the
   room, which is the growth loop.
   - **With M47 (2026-10-13):** onboarding for everyone's first sign-in. A
     welcome to pick a look, then *Get started*: connect your computer, start a
     room, bring your agent, invite a teammate. The first users are developers
     who already run Claude Code or Codex, so the desktop app is enough and M38
     doesn't block it.
   - **One change from its spec:** the recommended path is chosen by who the
     invitee is.
   - *Connect your Claude* (M38) when they have no terminal agent.
   - *Lane A* when they do.

5. **M42: Needs you.** *Hand it off,* and know it was handed to you.
   - A room is numbered when something in it is addressed to you: a mention, a
     handoff, a direct message, your agent finishing or stopping, a paused room
     you can resume.
   - Pushed live to the sidebar, the tab title and system notifications, and in
     the desktop app the dock and the tray.
     ([ADR 0037](decisions/0037-needs-you-is-derived-and-reaches-you-where-you-are.md)).
   - Per room: everything, what needs me, or nothing.
   - Asked for by the owner (2026-10-10): three rooms at once, and an agent
     waiting unseen in one of them.

### Phase 2: anyone can bring their agent

6. **M38: Your Claude, or ChatGPT, as a connector.**
   - A person adds Fabrikka **once** to their own Claude (claude.ai, Claude
     Desktop) or ChatGPT as a remote MCP connector. Their chat app's assistant
     can then read, write and produce in every room they're in.
   - **What it needs:**
     - An **OAuth authorization server** for the MCP endpoint. This ends ADR
       0009's deferral and needs a superseding ADR.
     - A **per-person endpoint** whose tools name the room. It's an addition to
       `docs/protocol.md`, so it needs extra care. Per-session tokens stay.
   - **The honest limit:** a connector agent acts only when its person prompts it
     in their chat app. It can't be spawned on a mention, and the room says so.
   - **A second limit, for self-hosting:** Claude and ChatGPT connect to a
     connector **from their own servers**, so the instance must be reachable
     from the internet. One behind a VPN, or on `localhost`, can't take
     connectors. Its people use the desktop app or lane A instead. Hosted and
     public self-hosted instances are fine.
     For people who'd otherwise not bring an agent at all, that's still the room
     working.
   - **Verify before building**, as M14 and M16 do:
     - which Claude and ChatGPT plans allow custom connectors;
     - that both complete OAuth with dynamic registration against a local
       instance;
     - how each renders tool results.
   - **Test:** one-time setup (open the chat app's connectors, add Fabrikka's
     URL, sign in, allow), then in any room, ask *"what did we decide yesterday?"*
     and get the room's answer. Nobody opens a terminal.
7. **Plain language for non-developers.**
   - No "MCP", "bridge", "lane" or "spawn" outside developer settings.
   - Templates for *a group paper*, *a study group*, *a proposal*, *a report*
     (M25 already makes templates).
   - Not its own milestone: part of M17 and M38's tests.

### Phase 3: anyone can host it

8. **M39: One image, one compose file.**
   - **A server container image:** the web app, API and MCP endpoint in one
     process. Migrations run at start.
   - **`docker-compose.yml` with the server, Postgres and Caddy (HTTPS),** for
     any VPS.
   - **Generated secrets:** the encryption key, and nothing a person has to
     invent.
   - **Uploads:** a persistent volume. S3-compatible storage waits until a
     deploy target has no disk; Render and Railway both do.
   - **Upgrades:** pull a newer image and restart. Backups are documented, not
     invented (Postgres dump, plus the uploads).
   - **The first owner is created in the browser.** Today it's
     `pnpm admin create-user`, which fails the five-click rule.
     - While an instance has no users, its first page creates the owner,
       protected by a setup code the deploy generated.
     - That's one-time setup, which the rule allows.
     - It touches the trust model, so it gets an ADR.
9. **M40: Deploy in one click.**
   - **First: Render.** One `render.yaml` in the repository (a Blueprint)
     declares the server, managed Postgres, a disk for uploads and generated
     secrets.
     - It's reviewed and versioned like any other file, so the button can't
       drift from the code.
     - The "Deploy to Render" button is a link to it.
   - **Second: Railway**, the other button self-hosters expect. Its template
     lives in Railway's dashboard, not the repository, so it's added once Render
     works and its setup is documented in `docs/operations.md`.
   - **Any VPS:** M39's compose file.
   - **Each is verified by deploying it for real before its button goes in the
     README**, the way vendors are ("verified, not documented").
   - **Test, clicks counted after signing in to the provider:** **Deploy** →
     **Apply/Create** → open the URL → **Create owner** (setup code, one-time)
     → **New room**. That's 5 clicks to a first room.
   - **Then from the room:** invite a teammate, and both bring an agent.

### Phase 4: open it

10. **License:** apply [ADR 0034](decisions/0034-license-agpl-3.0.md). That means
    the `LICENSE` file, headers, a contributor agreement, and the README's
    license section.
11. **Open the repository.**
    - The README leads with the pitch above, a 60-second demo video and the
      deploy buttons.
    - `CONTRIBUTING.md`, the contributor agreement and a security policy
      (`SECURITY.md`, how to report).

### Before strangers share a room

A public instance puts other people's text in front of agents that hold
someone's files and credentials. M6 already gates this. Before Phase 4, also:

- an external review of the trust model (`docs/security.md`) and the M38 OAuth
  server;
- rate limits and abuse handling on public instances;
- **M42: needs you** and **M43: call records expire** (built 2026-10-10,
  ahead of the sequence at the owner's request: "continue with things that
  don't need a human"). Their manual tests are the owner's.
- **M44: themes** (built 2026-10-10, ahead of the sequence at the owner's
  request; [ADR 0038](decisions/0038-themes-are-css-packs-checked-by-the-server.md)).
  Six built in, and anyone can make and share one (`docs/themes.md`).
- **M43: team call records expire,** 90 days by default, chosen by the team's
  owner from 30, 60, 90, 180 or 365.

## Who does what

Most of the MVP can be built by agents. **What can't is anything that needs your
accounts, your judgement or your clicks in a real app**: consent screens, and
the manual tests that gate each milestone.

**Two tracks run at once (2026-10-10, by the owner):**

- **Features** (Phases 0–2, 4) stay strictly sequential behind the manual tests.
- **Hosting** (M39, M40) doesn't change what a room does, so agents build it in
  parallel. It's the one exception to `CLAUDE.md`'s sequential rule, and it
  ends when M40 is tagged.

| Phase | Agents | You |
| --- | --- | --- |
| 0. Close what's open | Run every scripted check first, so your manual tests only cover what scripts can't. Write the missing `m36.mjs`. Prepare a click-by-click checklist per milestone. Write the Sentry or Grafana entry, then work out Atlassian's grant presets from the tool list of your real connection, with your OK, since it's your credential. | The manual tests for M19, M20, M24 and M34–M37. Accept ADRs 0031–0033. Create the GitHub OAuth App and put its keys in `.env`. Consent to Sentry or Grafana in the browser. |
| 1. The verbs | Build M15 and M17. Run their scripted checks, including the real model calls (`FABRIKKA_TEST_SPAWN=1`), with your OK each time. | The manual tests, with a second person or a second account. |
| 2. Anyone brings their agent | Build a local spike for the M38 check, so it takes one sitting. Then the OAuth ADR, and M38 itself. | Add the connector to your own Claude and ChatGPT, and say what worked. Accept the ADR. Run the manual test. |
| 3. Anyone can host it | **All of M39, now:** the image, compose with HTTPS, migrations at start, uploads storage, first owner in the browser (with its ADR). Write `render.yaml` and the deploy docs. | Deploy to Render with your account (M40's real test), then create the Railway template in its dashboard, following the docs. |
| 4. Open it | Draft the README, `SECURITY.md` and the demo script. | The CLA's text. The security review. Record the demo. |

## MVP acceptance

Run on an instance deployed with one click (M40), with real accounts.

1. **Developers: S1, team debugging.** Two engineers and their Claude Code and
   Codex. GitHub, Atlassian and Sentry or Grafana are connected. A PR is opened,
   a ticket is moved, and one agent is **redirected** mid-run (M15).
2. **Students: S9, a group paper.** Three students and an advisor. Two of the
   students bring Claude through the connector (M38), and nobody opens a
   terminal. The advisor comments without editing (M23). The paper compiles
   (M13).
3. **Office workers: a proposal.**
   - A team of three drafts a proposal in a `doc` output from a template, with
     at least one agent through the connector.
   - It's **handed off** across a weekend (M24): Monday's person picks up from
     the record.

**Success:** nobody pasted context into an agent. In stories 2 and 3, nobody
opened a terminal. Every path, deploy included, takes five clicks or fewer after
one-time setup.

## Not MVP

These are deferred, not dropped:

- **M14 (Google Docs).** The `doc` output covers the stories.
- **M16 (four more spawn adapters).** Lane A already admits any MCP client, and
  M38 covers the chat apps. OpenCode landed on 2026-10-15 (ADR 0047); the
  rest wait.
- **M26 (lending your agent), and lending steering to a teammate.** These are
  the first thing after MVP: redirecting *someone else's* agent is the
  multiplayer move no chat tool can make, and it needs the room proven first.
- **Shared agents the team runs** (the roadmap's *Later*). They come only if
  the room works.
- Everything already on the roadmap's *Explicitly not MVP* list.

## Decided (2026-10-10, by the owner)

- **License:** AGPL-3.0 with a contributor agreement (ADR 0034, accepted).
- **Self-hosting:** free, with no limits.
- **One-click deploy:** the most common and simplest first, which means Render
  (a Blueprint file in the repo), then Railway.
- **A deleted account's messages** stay in rooms other people still use, **under
  the author's name.** Who said what is part of the record.
- **Team call records** are kept 90 days by default, configurable (M43).
- **The promise:** Fabrikka never trains on users' content or sells it. It
  covers Fabrikka only; agents' providers have their own policies.
- **M20's issue-tracker runs:** both Jira and Linear.

## Learned from herdr (2026-10-14): the agent-state to-do

[herdr](https://github.com/herdrdev/herdr) owns terminals, so most of what it
builds is what ADR 0002 says not to build (screen detection, starting agents in
panes). Its *contracts* transfer. Each item names the milestone it belongs to;
none is a milestone of its own.

- [x] **1. `blocked` joins the status frame** (done 2026-10-16, M15 slice 1;
  no adapter emits it until item 4). Today
  the bridge sends only `working` and `idle`. An agent waiting on a permission
  prompt or an MCP elicitation is the state a shared room most needs. The spawn
  path sees it in the agent's stream. A correction that arrives while the agent
  is blocked goes to the human, not into the queue.
- [x] **2. Sequence numbers on status and run frames** (done 2026-10-16, M15
  slice 1: `seq` on every bridge frame, `completed` on an idle).
  Frames are best-effort over a reconnecting WebSocket, and a live session will
  have two sources of state (the channel and a hook). A frame whose number is
  not above the last accepted is dropped. A separate completion marker tells
  "finished work" apart from "idle at startup", which M24's waiting list needs.
- [x] **3. A reporting contract instead of adapters** (done 2026-10-16,
  ADR 0054, `docs/protocol.md` section 4; the adapters keep their parsers).
  Herdr
  gets 25 agents from three documented calls: report state, report the resume
  command, release on exit; only when its env vars are set, in the background,
  ignoring failures. Fabrikka's version rides on the bridge the agent already
  spawns. The agent reports; Fabrikka supervises nothing, so ADR 0002 holds.
- [ ] **4. Precise live-session state through the agent's own hooks** (M15,
  needs an ADR: it sits on ADR 0002's edge). Claude Code's `SessionStart`,
  `UserPromptSubmit` and `Stop` hooks post to the bridge, which is how herdr's
  own integrations work. Installing a hook writes one managed, versioned file
  into the agent's config, only when the person asks, and the agent still owns
  everything else.
- [ ] **5. Resume as validated data** (M15, ADR 0016). The resume command is an
  argv the agent supplies. Accept it only if the first word is a bare command on
  PATH, no argument has an apostrophe or a control character, there are at most
  64 arguments and 8 KiB, and the source reporting it owns the run.
- [x] **6. Compatibility rules in `docs/protocol.md`** (done 2026-10-16, the
  section *How this contract may change*). The bridge is self-updating and the
  server moves faster, and the doc never said how frames may evolve. Four
  rules: published frames are immutable; new fields are optional with a
  defined absence; enums get an unknown fallback; a missing capability
  disables one action, never the connection.
- [ ] **7. Version the catalogue entries** (M18). Presets drift weekly as vendors
  add tools. Each entry gets `version` and `updated_at`, as herdr's manifests
  do, so an instance can say which presets it runs. Patching entries without a
  release, with a local override that wins, comes after, if the drift hurts.
