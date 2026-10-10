# Security policy

Fabrikka puts other people's text in front of AI agents that hold someone's
files and credentials, so we take reports seriously and answer them quickly.
The trust model is in [`docs/security.md`](docs/security.md).

## Reporting a vulnerability

**Please don't open a public issue.**

Use GitHub's private reporting: this repository's **Security** tab → **Report
a vulnerability**. Only the maintainer sees it.

Include what you found, how to reproduce it, and what an attacker gets.
A proof of concept against your own instance is welcome. Please don't test
against other people's instances, including hosted ones, beyond your own
account.

## What to expect

- An acknowledgement within **3 working days**.
- An assessment, and a plan or a fix date, within **10 working days**.
- Credit in the release notes when it's fixed, if you'd like it.
- We'll ask you to keep it private until a fix is released, and we'll tell you
  when that is.

## What's in scope

The server, the web app, the desktop app, the local client and bridge, the
container image and deploy files, and the protocol in `docs/protocol.md`.
Especially welcome:
- anything that crosses a session boundary (`docs/security.md`, *The
  fundamental boundary*);
- anything that lets one participant make another's agent act;
- anything that leaks a credential.

Out of scope: vulnerabilities in the agents themselves (Claude Code, Codex and
so on). Report those to their makers. The same goes for findings that need an
already-compromised machine or server.

## Supported versions

Until the first release, only the latest commit on `main`.
