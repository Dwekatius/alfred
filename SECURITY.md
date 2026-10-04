# Security policy

Alfred can control a Windows desktop through a Telegram bot. A vulnerability here is not "a broken
page" — it can be someone else's mouse and keyboard. Please treat it accordingly.

## Supported versions

Only the latest release on `main` is supported. There are no long-term branches yet
(current version: 0.1.x).

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Preferred: use GitHub's private vulnerability reporting on
<https://github.com/Dwekatius/alfred/security/advisories/new> (repository → *Security* →
*Report a vulnerability*). That keeps the details private until a fix is out.

If that link is unavailable, open a minimal public issue that says only *"I have a security report,
please provide a private channel"* — with no details — and we will follow up.

Please include:

- affected version/commit and Windows build,
- what an attacker can do and what they need (local user? the chat? a malicious website?),
- the smallest reproduction you can manage (config with secrets removed, log excerpts, steps),
- whether secrets, files, or the desktop can be reached, and if you have tested on a clean install.

**Never include** your bot token, provider API keys, real Telegram ids, or unredacted logs.

## What to expect

- Acknowledgement within a few days, best effort (this is a small project without a bounty).
- A fix or a documented mitigation, plus credit in the release notes if you want it.
- If the issue is a limitation rather than a bug (for example "the model can be prompt-injected by a
  website"), it will be documented in `docs/security.md` rather than patched away — that file is the
  honest description of what this project does and does not protect against.

## Scope

**In scope:** anything that lets someone who is *not* the paired Telegram owner control the
machine, read secrets, bypass approvals/`dryRun`, escape the worker sandbox, reach the dashboard
from another machine, or leak credentials through logs, config, sessions or git.

**Out of scope:** malware already running as your user, physical access, Telegram's own servers,
your model provider's data handling, captchas and anti-automation measures, and the fundamental
fact that an agent allowed to click and type can be talked into bad plans by injected text
(mitigated by approvals and budgets — see `docs/security.md`).
