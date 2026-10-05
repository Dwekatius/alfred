# Getting started — from a bare Windows PC to a working assistant

This is the complete, start-to-finish guide. Follow it in order; each step tells you what to
expect and what to do if it fails. Budget **20–30 minutes** the first time, most of it downloads.

- [0. What you will end up with](#0-what-you-will-end-up-with)
- [1. Before you start](#1-before-you-start)
- [2. Get the code](#2-get-the-code)
- [3. Run the one-click setup](#3-run-the-one-click-setup)
- [4. Create your Telegram bot](#4-create-your-telegram-bot)
- [5. Pair your Telegram account](#5-pair-your-telegram-account)
- [6. Choose a model and add a key](#6-choose-a-model-and-add-a-key)
- [7. Sign in to the browser profile](#7-sign-in-to-the-browser-profile)
- [8. Start the assistant](#8-start-the-assistant)
- [9. Your first tasks](#9-your-first-tasks)
- [10. Day-to-day use](#10-day-to-day-use)
- [11. Updates, backups and maintenance](#11-updates-backups-and-maintenance)
- [12. Where everything lives](#12-where-everything-lives)
- [13. Uninstalling](#13-uninstalling)
- [14. If something is wrong](#14-if-something-is-wrong)

---

## 0. What you will end up with

A private Telegram bot that only you can talk to. You send it a message; it works on your PC in
the background — opening real apps, driving a real Chrome window, reading and writing files,
running commands — and replies in the same chat with answers, screenshots and files.

Nothing is exposed to the internet. The assistant polls Telegram (outbound only) and serves a
local dashboard on `127.0.0.1` that is protected by a per-install token.

Costs: Telegram is free. The model is whatever you connect — a free provider tier, a paid API key,
or a local model that costs nothing per token.

## 1. Before you start

You need:

| Requirement | Why | Where |
|---|---|---|
| **Windows 10 or 11** | The assistant drives the real desktop and UI Automation | — |
| **An interactive, unlocked session** | Screen capture, mouse and keyboard need a real desktop | — |
| **Node.js 24.15.x** | Runs the controller, workers and dashboard | [nodejs.org](https://nodejs.org/) — pick the LTS installer, default options |
| **Python 3.10+** (3.14 recommended) | Backends for Windows automation and the DPAPI secret tool | [python.org](https://www.python.org/downloads/windows/) — tick **Add python.exe to PATH** |
| **Google Chrome** | The assistant opens its own Chrome window and profile | [google.com/chrome](https://www.google.com/chrome/) |
| **A Telegram account** | That is the remote control | [telegram.org](https://telegram.org/) — desktop or mobile app |

Two more things worth deciding now:

- **Which model provider** you want to use (§6). A free tier is fine to start.
- **Whether this PC can stay logged in** while the assistant works. Locking the screen pauses
  desktop automation — that is a Windows security rule, not a limitation of this project.

> **Do not** install this on a machine that other people use, or on a work machine where an
> unattended agent clicking and typing would be a problem. See
> [security.md](security.md) before you decide.

Verify the two command-line tools open. Press `Win+R`, type `powershell`, press Enter, then:

```powershell
node --version    # expect v24.15.0 or newer v24.x
python --version  # expect Python 3.10 or newer (3.14.x is what we test)
```

If a command is "not recognized", the installer did not add it to `PATH` — reinstall and tick the
PATH option (Node does this by default; Python does not).

## 2. Get the code

Put the project somewhere stable, for example `C:\Tools\alfred` or your Desktop.

**With git:**

```powershell
cd C:\Tools
git clone https://github.com/Dwekatius/alfred.git
cd alfred
```

**Without git:** open the repository page, click **Code → Download ZIP**, extract it, and open the
folder. Avoid extracting into `C:\Program Files` — the setup writes a `.venv` and `node_modules`
next to the code, and Windows protects that directory.

Everything the assistant *produces at runtime* (database, logs, sessions, browser profile) lives
outside the project in `%USERPROFILE%\.pi\alfred`, so you can move, update or re-clone the code at
any time without losing history.

## 3. Run the one-click setup

Double-click **`Setup Alfred.cmd`** in the project root.

A console window opens and performs, in order:

1. **Node.js check** — version and presence.
2. **JavaScript dependencies** — `npm ci` (first run: a few minutes).
3. **Python environment** — creates `.venv` and installs the pinned backend requirements.
4. **Build** — compiles the TypeScript app.
5. **Dashboard & Setup guide** — starts the local dashboard and opens the **Setup guide** in a
   clean app window.

Expected tail of the output:

```text
[ok] Node.js 24.15.0
[ok] JavaScript dependencies present
[..] Building the application...
[ok] Build complete
[..] Starting the local dashboard...
The setup guide is open in the app window. Follow steps 1-6.
```

If the console reports a failure, fix the printed cause and run `Setup Alfred.cmd` again — it is
safe to re-run at any time and skips work that is already done.

The wizard checks each step live. Steps 1–6 are:

1. prerequisites
2. create your bot and paste its token
3. pair your Telegram chat
4. choose the AI model
5. browser sign-in
6. start the assistant

The rest of this guide expands those steps and adds the things the wizard cannot do for you.

## 4. Create your Telegram bot

You need a bot *of your own*; there is no shared bot.

1. Open Telegram and search for **@BotFather** (the one with the blue checkmark).
2. Send `/newbot`.
3. Give it a **display name** — e.g. `Alfred`.
4. Give it a **username** — must be unique and end in `bot`, e.g. `my_alfred_bot`.
5. BotFather replies with a token that looks like:

   ```text
   1234567890:AAH9xY7kQm2vT4pL8sR6wZ1bN3cD5eF7gH
   ```

**Treat that token like a password.** Anyone who has it can read your bot's messages. Never paste
it into the Telegram chat itself, into a screenshot, or into a git commit — the assistant only
ever asks for it locally, in the app window, where it is verified with Telegram's `getMe` and then
encrypted with Windows DPAPI for your user account.

Optional but recommended, still in BotFather:

- `/setdescription` and `/setabouttext` — so the bot looks intentional in your chat list.
- `/setcommands` — paste the command list from [configuration.md](configuration.md) if you want
  Telegram's command menu populated.
- **Do not** set a webhook. Alfred uses long polling, and a webhook would block it; the wizard
  offers to delete one if it finds it.

Back in the app window, paste the token into **step 2** and press **Verify & save**. The wizard
calls Telegram, confirms it can see your bot, and stores the token encrypted.

## 5. Pair your Telegram account

Pairing binds the bot to exactly one Telegram account, using a one-time code that only exists on
your PC.

1. In the wizard, **step 3 → Start pairing**. A code and a `t.me` deep link appear, and a short
   countdown starts.
2. Open the bot in Telegram (click the deep link, or search for the bot you created).
3. Send:

   ```text
   /start <code>
   ```

4. The wizard shows the numeric Telegram user ID and chat ID that tried to pair. Confirm them.
   Only after you accept locally are the IDs written to the config.

Notes:

- The code is single-use and expires quickly. If it lapses, press **Start pairing** again.
- A message from any *other* Telegram account is ignored, even if it guesses the code.
- Optional second factor: the wizard can also display the code in the *bot's* chat only
  (if you prefer to copy-paste rather than type).
- If you ever change Telegram accounts, re-pair from the dashboard.

## 6. Choose a model and add a key

**Step 4** in the wizard lists model slots. A slot is a named provider + model pair, and the one
marked **ACTIVE** handles the next job. You can keep several (one per provider) and switch from
chat with `/model <slot>`.

Built-in slots:

| Slot | Provider / model | Notes |
|---|---|---|
| `deepseek` | `deepseek/deepseek-flash` | Cheapest strong option; excellent tool use, native reasoning |
| `openrouter` | any OpenRouter model | One key for hundreds of models, including free ones |
| `zai` | `zai/glm-5.3-flash` | Fast, inexpensive |
| `anthropic` | `anthropic/claude-sonnet-5-5` | Strongest reasoning and computer use |
| `openai` | `openai/gpt-6.1-sol` | Strong general model |
| `lmstudio` | local OpenAI-compatible server | No cloud key, nothing leaves your PC |

To configure one:

1. Click **Configure** on a slot.
2. Paste the API key for that provider. The wizard validates it live against the provider's API —
   a typo is rejected immediately rather than failing on your first task.
3. The key is encrypted with DPAPI and stored in `%USERPROFILE%\.pi\alfred\secrets`.
4. Click **Use** to make the slot active.

**Free and local options**

- **OpenRouter free models** — create a key at openrouter.ai, then pick a model whose price is
  `$0`. Alfred can enforce this (`requireZeroTokenPrice`), so you cannot accidentally start paying.
- **LM Studio / Ollama / vLLM** — start your local server (LM Studio default:
  `http://127.0.0.1:1234/v1`), then configure the `lmstudio` slot with that endpoint and the model
  id your server exposes. No cloud key is needed and no prompt leaves the machine. Local models
  are slower and weaker at long tool chains — great for simple tasks and privacy-sensitive ones.
- **Already using Pi?** If `%USERPROFILE%\.pi\agent\auth.json` exists, its keys are detected and
  can be reused — the wizard shows *Existing Pi credentials* on the slot. Alfred never modifies
  that file.

**Thinking level.** Reasoning models expose a budget. Set it in the wizard or later with
`/thinking low|medium|high|xhigh|max`. Higher means better planning and more tokens spent; start
at `high` and raise it for messy multi-step work.

## 7. Sign in to the browser profile

The assistant drives its own Chrome window with its own profile:

```text
%USERPROFILE%\.pi\alfred\browser\profile
```

That profile is empty at first, which is exactly what you want: it is not your daily profile, so
you can stay signed into Gmail, GitHub or a company portal there without giving the assistant
access to your normal browsing session.

1. In the wizard, **step 5 → Open the agent browser** (or run
   `powershell -File scripts\browser-signin.ps1`).
2. A Chrome window opens on that profile. Sign in to whatever you want the assistant to use —
   email, a docs site, a project tracker.
3. **Close that Chrome window** when you are done. Chrome locks a profile while it is open, so
   browser tasks need it closed. The assistant launches it again by itself when a task needs it.

What if you skip this step? Everything still works; sites that require a login will show their
sign-in page, and the assistant reports `LOGIN_REQUIRED` instead of guessing credentials.

## 8. Start the assistant

**Step 6 → Start.** That is it — the wizard starts the controller and the dashboard begins showing
model activity.

Recommended, so it survives reboots:

- **Settings → Startup → Start assistant when I sign in to Windows.** This registers a per-user
  task called `Alfred` that runs hidden at logon. It applies immediately and can be switched off
  the same way.
- **Tray shortcut.** `npm run install-tray` (or `scripts/install-tray.ps1 -Startup`) puts an
  **Alfred** shortcut on your Desktop; `-Startup` also adds it to the Startup folder. The tray icon shows state at a glance:
  green = idle, blue = working, orange = paused, grey = stopped. Right-click for Start, Stop,
  Restart, Pause, Resume, Open logs, Open config, Run doctor, Pair.

The desktop shortcut and dashboard Start button also work when the sign-in task is not installed. They launch the controller hidden with your current configuration. Reopening the desktop shortcut keeps one tray icon and one running controller.

The dashboard is also a normal local web app if you prefer a browser tab:
`http://127.0.0.1:8787/?token=<your token>` — the token is in
`%USERPROFILE%\.pi\alfred\state\dashboard.json`, and the *Alfred Dashboard* shortcut opens it with
the token already applied.

Sanity check from a terminal:

```powershell
npm run doctor
```

You are looking for `24/24 checks passed`. Two entries are worth understanding:

- `Interactive session: desktop=Default` — the agent can see the desktop.
- `Controller lock: running (pid …)` — exactly one controller instance is in charge.

## 9. Your first tasks

Open your bot's chat and send a plain sentence — no slash. Examples that exercise different
abilities, in increasing order of ambition:

```text
what is on my screen right now?
open notepad and write a haiku about mondays
open chrome, search for "cheapest mechanical keyboard", and tell me the top 3 results
create a folder on my Desktop called invoices and move every pdf from Downloads into it
read C:\Users\me\Desktop\notes.txt and summarise it in three bullets
take a screenshot of the browser window and send it to me
```

What you should observe:

1. The message is accepted (a small "queued/starting" acknowledgement).
2. The dashboard's **Model activity** panel streams thinking and answer blocks, tool calls, and a
   usage line with tokens, tok/s, ttft, wall time and cost.
3. For long jobs you get periodic progress notes; for destructive steps you get an approval
   prompt with buttons.
4. The final reply arrives in chat, with screenshots or files attached when relevant.

Useful first commands:

```text
/status                     what the assistant is doing right now
/screenshot                 desktop screenshot on demand
/stop                       cancel the active job
/help                       the command list
```

## 10. Day-to-day use

### Chat commands

| Command | Purpose |
|---|---|
| `/status` | Active job, queue, model, session and controller state |
| `/pause`, `/resume` | Pause/resume the active job at a safe boundary |
| `/stop` | Cancel the active job; `/stop all` cancels everything queued |
| `/queue` | Show what is waiting behind the active job |
| `/cancel <jobId>` | Cancel one specific queued job |
| `/run-next` | Start the next queued job immediately |
| `/screenshot [window]` | Desktop (or focused-window) screenshot |
| `/new` | Start a fresh conversation session (clears model context) |
| `/model` | Show slots; `/model <slot>` switch; `/model <slot> <model-id>` configure |
| `/provider <name>` | Show or select a provider slot |
| `/thinking <level>` | `low`, `medium`, `high`, `xhigh`, `max` |
| `/tell <instruction>` | Send a message into a *running* job without cancelling it |
| `/approve <id>`, `/reject <id>` | Answer an approval request from the keyboard |
| `/help` | Command reference |

Anything that does not start with `/` is a task for the model.

### The safety rails you will actually notice

- **Approval prompts.** Destructive or sensitive actions (deleting files, sending mail, submitting
  forms, spending money) arrive as a message with **Approve/Reject** buttons. Denied means denied —
  the model is told the action was refused.
- **Pause on human input.** Touch the mouse or keyboard while a job drives the PC and it pauses at
  the next safe boundary, then asks whether to continue (`/resume`) or drop it (`/stop`).
- **Emergency hotkey.** `Ctrl+Alt+F9` cancels the active job instantly, no Telegram round-trip.
- **Walls.** A job that exceeds its time budget, tool-call budget, model-turn budget, or makes no
  progress is stopped and reported. Defaults live in `jobs` in
  [configuration.md](configuration.md).
- **`dryRun`** in `config.json` lets the model plan and call tools that only *report* what they
  would do. Use it to study behaviour before letting it loose.

### Dashboard

- **Dashboard tab** — controller state, live model activity (collapsible thinking, answers, tool
  calls, usage lines with tok/s), and token/cost charts by day, week or month.
- **Setup guide tab** — the same wizard used during installation; every check is live, so it doubles
  as a diagnostic tool.
- **Settings tab** — startup toggle, pause-on-input, emergency hotkey, max run time, queue limit,
  artifact retention, theme.
- Themes: **Auto / Light / Dark**, remembered per profile.

## 11. Updates, backups and maintenance

```powershell
git pull
npm ci            # only if dependencies changed
npm run build
npm run stop && npm run start    # or just Restart from the tray
```

Your data is not in the repository, so updates never touch it. To be safe anyway:

```powershell
powershell -File scripts\backup.ps1        # zips config + state + sessions
powershell -File scripts\backup.ps1 -Help  # options, including the database only
```

Maintenance you may want to schedule:

- `npm run doctor` after Windows updates or Chrome upgrades.
- Review `%USERPROFILE%\.pi\alfred\logs\` when something odd happens; logs are redacted (tokens,
  API keys and message bodies are masked by the logger).
- Artifact retention is automatic (7 days / 1 GiB by default) and configurable.

### Upgrading your bot token

If a token leaks: BotFather → `/revoke` → paste the new token in the Setup guide (step 2). The old
token stops working immediately; your pairing and history are unaffected.

## 12. Where everything lives

| Path | Contents |
|---|---|
| `%USERPROFILE%\.pi\alfred\config.json` | Your configuration (no secrets) |
| `%USERPROFILE%\.pi\alfred\secrets\` | DPAPI-encrypted bot token and API keys |
| `%USERPROFILE%\.pi\alfred\state\jobs.sqlite` | Jobs, events, conversations, usage, telemetry |
| `%USERPROFILE%\.pi\alfred\state\dashboard.json` | Dashboard port and access token |
| `%USERPROFILE%\.pi\alfred\sessions\` | Model conversations (one JSONL per session) |
| `%USERPROFILE%\.pi\alfred\browser\profile\` | The assistant's dedicated Chrome profile |
| `%USERPROFILE%\.pi\alfred\artifacts\` | Screenshots and generated files, with retention |
| `%USERPROFILE%\.pi\alfred\logs\` | Rotating logs, redacted |
| `<project>\.venv`, `<project>\node_modules` | Dependencies (never copy these into a repo) |

## 13. Uninstalling

1. Stop it: tray → **Stop**, or `npm run stop`.
2. Remove autostart: Settings → Startup toggle, or `npm run remove-startup`.
3. Remove the tray shortcut: `npm run remove-tray`.
4. Delete your data (optional, irreversible): `%USERPROFILE%\.pi\alfred`.
5. Delete the project folder (and its `.venv` / `node_modules`).
6. BotFather → `/deletebot` if you want the bot gone from Telegram.

## 14. If something is wrong

Start with these three, in order:

```powershell
npm run doctor                     # environment, session, credentials, auth
npm run status                     # is the controller actually running?
npm run tray -- -Action restart    # clean restart of the controller
```

Then see [troubleshooting.md](troubleshooting.md) for symptom → cause → fix, including:

- the bot does not answer at all,
- `PROFILE_IN_USE` / `LOGIN_REQUIRED` browser errors,
- `DESKTOP_LOCKED` / `SECURE_DESKTOP` desktop errors,
- model errors and rate limits,
- port and lock conflicts,
- what to include when you ask for help.
