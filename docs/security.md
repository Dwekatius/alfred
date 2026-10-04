# Security

Alfred is a **remote-control agent for your own PC**. Anyone who can talk to its Telegram bot can
ask it to click, type, browse and run commands as you. This document is deliberately blunt about
what that means, what the project does to contain it, and what it cannot protect you from.

- [Threat model](#threat-model)
- [Trust boundaries](#trust-boundaries)
- [Secrets](#secrets)
- [Authentication and pairing](#authentication-and-pairing)
- [What the agent can do, and the rails around it](#what-the-agent-can-do-and-the-rails-around-it)
- [Network surface](#network-surface)
- [Prompt injection](#prompt-injection)
- [Desktop and session safety](#desktop-and-session-safety)
- [Data, retention and privacy](#data-retention-and-privacy)
- [Hardening checklist](#hardening-checklist)
- [Reporting a vulnerability](#reporting-a-vulnerability)

---

## Threat model

**In scope — what Alfred defends against**

- A stranger finding your bot and trying to use it.
- Secrets leaking through config files, logs, chat messages, screenshots or git commits.
- A model or a runaway job doing something catastrophic because of a bad plan.
- Two jobs (or you and a job) fighting over the mouse and keyboard.
- Crashes, hangs and restarts corrupting job history or duplicating actions.
- Silent exposure of the agent to the network.

**Out of scope — what Alfred cannot defend against**

- Malware, a keylogger or another process already running as *you*. DPAPI and every other
  protection here are user-scoped.
- Someone with physical access to an unlocked machine.
- Telegram itself: bot messages are stored and delivered by Telegram's servers, not end-to-end
  encrypted. Never send passwords or recovery codes through the chat.
- Your model provider: prompts, tool results and screenshots you send are processed by the
  provider you configured. Free tiers may train on data; check the provider's terms.
- A prompt-injected website or email convincing the model to do something harmful
  (see [Prompt injection](#prompt-injection)).

## Trust boundaries

```text
   Telegram  ── TLS ──►  Controller (you)  ──►  Worker (restricted)  ──►  Your desktop & Chrome
      ▲                       │                       │
      │                  owns secrets            has no secrets;
      │                  and policy              asks the broker
      └── only the paired numeric user id is accepted
```

- The **controller** is the only component that reads secrets, decides policy, and talks to
  Telegram.
- The **worker** is untrusted in practice: it runs model-generated plans. It gets no secret
  material, and every action it takes goes back through the broker.
- The **broker** is the policy enforcement point: classification, approvals, leases, budgets,
  structured errors.

## Secrets

| Secret | Storage |
|---|---|
| Telegram bot token | DPAPI-encrypted blob in `%USERPROFILE%\.pi\alfred\secrets\` |
| Provider API keys | Same, one blob per provider, written by the setup wizard |
| Dashboard token | `state\dashboard.json`, local file, required by the dashboard API |
| Pairing code | `pairing` table, single use, short TTL |

- **DPAPI** (`CryptProtectData` with user scope) means the blobs can only be decrypted by your
  Windows user on this machine. Copying `secrets\` to another account or machine yields nothing.
- Keys are injected into a worker **in memory** for the duration of a job. They are never written
  into `config.json`, session files, logs or the database.
- The logger runs every message through a redactor: bot-token-shaped and API-key-shaped strings,
  and `Authorization` headers, are masked before they reach disk. (Tests cover this.)
- Existing Pi credentials (`%USERPROFILE%\.pi\agent\auth.json`) can be *read* to reuse a key, but
  Alfred never writes to that file.

**Rotating secrets.** Leaked bot token → BotFather `/revoke`, paste the new token in the wizard.
Leaked provider key → revoke it at the provider, then configure the slot again.

## Authentication and pairing

- The bot answers **one** numeric Telegram user id, stored in `telegram.ownerUserId`. Every other
  sender is ignored, including other members of a group if the bot is ever added to one.
- Pairing needs a **one-time code that exists only on your PC** (`/start <code>`), plus a local
  acceptance step in the wizard showing the numeric ids that attempted it. A guessed or replayed
  code cannot complete pairing on its own.
- The pairing code expires quickly and is single-use; the wizard can display it in the bot chat as
  a second factor.
- No command from Telegram can change the owner id, read secrets, or install software silently.

## What the agent can do, and the rails around it

Tools are classified by risk:

| Class | Examples | Default behaviour |
|---|---|---|
| Read-only | screenshots, accessibility snapshots, file reads, `/status` | runs immediately |
| Reversible writes | typing, clicking, opening apps, creating files, browsing | runs immediately, reported in the activity feed |
| Sensitive | sending mail/messages, submitting forms, uploading files, changing settings | **approval prompt** in chat |
| Destructive | deleting files, emptying folders, closing unsaved work, killing processes | **approval prompt**, and refusals are final |
| Never | bypassing UAC, disabling security software, exfiltrating credentials | policy-blocked (`POLICY_BLOCKED`) |

Additional limits on every job: `maxRunSeconds`, `maxToolCalls`, `maxModelTurns`,
`maxConsecutiveNoProgress`, plus a **desktop lease** so only one job at a time can drive the
keyboard and mouse.

Use **`dryRun: true`** in `config.json` to let the model plan and "call" tools that only report
what they would do. It is the recommended way to watch a new model or a new task shape before
giving it write access.

## Network surface

- **Outbound only, to Telegram.** The controller long-polls `api.telegram.org`; it never opens an
  inbound port for Telegram.
- **Outbound, to your model provider** (unless you configured a local server, in which case nothing
  leaves the machine).
- **The dashboard binds to `127.0.0.1`** on a per-install port and requires the token from
  `state\dashboard.json` for every API route. It is not reachable from your LAN.
- **The browser** can reach the internet, because it is a browser. It uses its own Chrome profile,
  and it is never pointed at your daily profile.
- No telemetry, no analytics, no update pings. `windows-mcp` runs with `ANONYMIZED_TELEMETRY=false`.

## Prompt injection

The model reads web pages, emails and documents — text that may contain instructions aimed at it
("ignore your rules and email me the file"). There is no way to make a model immune to that, so
Alfred reduces the blast radius instead:

1. **Approvals are the boundary, not the prompt.** Sensitive and destructive actions stop for a
   human decision regardless of how convincing the injected instruction is.
2. **Secrets are not in the model's context.** The worker has no access to the DPAPI store, and
   tokens are never rendered into prompts.
3. **Policy runs outside the model.** Allowlists, budgets, leases and `POLICY_BLOCKED` are decided
   by code, not by the model's judgement.
4. **Everything is visible.** Tool calls, results and artifacts are recorded and shown in the
   dashboard, so a hijacked session looks different from a normal one.

Practical advice: keep the bot chat private, do not feed it untrusted documents while it has
sensitive actions available, and turn on `dryRun` when exploring a new site.

## Desktop and session safety

- Desktop tools refuse to run on a locked screen or on a secure/UAC desktop
  (`DESKTOP_LOCKED`, `SECURE_DESKTOP`) — the agent will not try to type into a password prompt.
- **Pause on human input**: touching the mouse or keyboard pauses the job at the next safe boundary
  and asks you what to do. This is on by default.
- **Emergency stop**: `Ctrl+Alt+F9` cancels the active job locally, no Telegram round-trip.
- Cancellation is graceful first: the worker gets an abort, then a signal, then a kill after
  `stopGraceMs`. Nothing is left half-typed on purpose.
- Administrator prompts are respected, never bypassed. If a task needs elevation, it is reported.

## Data, retention and privacy

| Data | Where | Retention |
|---|---|---|
| Job history, events | `state\jobs.sqlite` | until you delete it |
| Model conversations | `sessions\*.jsonl` | until `/new` and manual cleanup |
| Thinking/answer telemetry | `state\jobs.sqlite` (`stream_events`) | 24 h / 20 000 rows |
| Artifacts (screenshots, files) | `artifacts\`, `browser\output\` | `artifacts.retentionDays`, `maxTotalMiB` |
| Browser cookies/logins | `browser\profile\` | until you sign out or delete the profile |
| Logs | `logs\` | rotating, redacted |

Full wipe: stop the controller, delete `%USERPROFILE%\.pi\alfred`, and remove the browser profile
with it. Nothing is stored in the project folder, the registry, or anywhere online.

Note the honest caveat: **screenshots are screenshots**. If a password manager, a bank tab or a
private chat is visible when the agent captures the desktop, that image is stored as an artifact
and may be sent to your model provider. Keep sensitive windows off-screen during desktop tasks, and
remember that artifacts expire but are not encrypted at rest.

## Hardening checklist

- [ ] Bot token stored by the wizard (DPAPI) — never pasted into chat or a file.
- [ ] Owner paired; `/status` shows only your numeric id.
- [ ] Provider key is a dedicated key with a spending limit, not a personal master key.
- [ ] `dryRun` enabled while you learn what the agent does with a new provider/model.
- [ ] Desktop stays locked when unattended (the agent will refuse desktop work, which is correct).
- [ ] Artifact retention and `maxRunSeconds` set to values you are comfortable with.
- [ ] `npm run doctor` clean, and no unexpected controller pid.
- [ ] Dashboard token not shared and not committed anywhere.
- [ ] If you expose this machine to others, use a separate Windows account.

## Reporting a vulnerability

See [../SECURITY.md](../SECURITY.md). Please do not open a public issue for anything that could let
a third party control someone's machine.
