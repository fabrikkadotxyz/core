# 0061 — A face for everyone, a picture for people who want one

**Status:** Proposed
**Date:** 2026-10-21
**Builds on:** [ADR 0060](0060-files-live-on-disk-or-in-an-s3-compatible-bucket.md)
(the file store, amended here: pictures can be deleted),
[ADR 0057](0057-leaving-an-account-is-deactivated-then-deleted-the-record-stays.md)
(what leaving removes).

## Context

A room says who wrote a line with a word and an emoji: 👤 for a person, 🤖
for an agent. Three people and two agents in a busy room read as one column
of names. The only faces in the product were a letter on the account button
and coloured initials in a document's history, each made its own way.

The owner's decision (2026-10-21): a person may upload a profile picture in
their own settings. Without one, they get initials on a colour: the first
letter of the first name and of the last name, or the first two letters of a
single name, on a colour from a palette, picked at random.

## Decision

**1. Everyone has a face.** People and agents, everywhere a name stands for
someone: a message's author, the room's people, an organization's members,
the people picker, the account button. A face is the picture if the person
has one, otherwise initials on a colour. Agents never have a picture, and
their face is a rounded square, not a circle, so an agent is never mistaken
for a person.

**2. Initials.** The name is split on spaces. Two or more words: the first
letter of the first and of the last (`Daniel Levy` → `DL`,
`Ana María López` → `AL`). One word: its first two letters (`claude-daniel`
→ `CL`, `Mei` → `ME`). Upper case, letters as written, a leading `@` ignored.
No name: `?`.

**3. The colour is random but stable.** Picked from an eight-colour palette
by a hash of the person's account id (an agent's participant id), so it
looks random across a room but is the same for everyone, everywhere, and
does not change when the name does. The palette is eight theme tokens,
`--face-1` to `--face-8`, with text in `--on-face`; a theme may restyle
them (`docs/themes.md`).

**4. A picture is chosen in Settings → Account.** *Choose a picture* opens
the file picker; *Remove* goes back to initials. Four clicks from anywhere:
Settings, Account, Choose a picture, the file.

**5. The browser makes the picture; the server checks it.** The web app
crops the chosen image to its centre square and re-encodes it at 256 × 256
(WebP, PNG where WebP is not available). That keeps every picture small and
strips what a camera writes into a photo, including where it was taken. The
server accepts only PNG, JPEG or WebP, recognised by their first bytes, not
by name or declared type, and at most 512 KB. Never SVG: it is a document
that can run script.

**6. Stored in the file store, by content.** The bytes go into the
instance's store (disk or bucket, ADR 0060) under
`avatars/ab/cd/<sha-256>`, and `users.avatar_key` holds the hash. Unlike a
room's files, a picture is deleted: when it is replaced or removed, and when
the account is deleted, unless another account holds the identical bytes.
ADR 0060's "never deleted" stays true for a room's files; the store gains a
delete, and only pictures use it.

**7. Served by content address, to people signed in.**
`GET /api/avatars/<hash>` serves a picture that a current account holds, to
anyone signed in to the instance, with `Cache-Control: private, immutable`
and `Content-Security-Policy: default-src 'none'`, `nosniff`. A new picture
is a new address, so caches never show an old one. The address appears only
where the person does (rooms, organizations, the people picker), so knowing
it means having been shown the picture; the payload, not the picture route,
is where membership is checked. Signed out, there is no picture, and the
initials show.

**8. It is personal data.** Download my data (M62) includes the picture.
Deleting an account (ADR 0057) removes it, whether or not the name is kept.
A deactivated account keeps it, since reactivation must bring it back.
Changing or removing it is in the trail (`profile.picture_changed`,
`profile.picture_removed`).

**9. Not in the protocol.** Agents read names over MCP as before; a picture
is the web app's. `docs/protocol.md` does not change.

## Consequences

- One `Face` component replaces the emoji, the account button's letter and
  the history's circles. The history knows participants, not accounts, so
  its faces are initials coloured by participant, without pictures.
- Payloads that name a person carry `avatarUrl` (null for none) and, where
  they did not already, the `userId` the colour is taken from.
- An instance on a bucket keeps pictures in the bucket, under the same
  prefix.

## Not decided here

Pictures for agents or organizations, a picture per room (rooms already let
a person use a different name), and moderation of what people upload.
