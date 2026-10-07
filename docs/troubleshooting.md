# Troubleshooting

Start here, always:

```powershell
npm run doctor                     # environment, session, credentials, Telegram, lock
npm run status                     # is the controller running, what is it doing
npm run tray -- -Action restart    # clean restart
```

Then find your symptom below.

- [First aid](#first-aid)
- [The bot does not answer](#the-bot-does-not-answer)
- [Setup problems](#setup-problems)
- [Pairing problems](#pairing-problems)
- [Model and provider errors](#model-and-provider-errors)
- [Browser errors](#browser-errors)
- [Desktop errors](#desktop-errors)
- [Dashboard problems](#dashboard-problems)
- [Controller, tray and startup problems](#controller-tray-and-startup-problems)
- [Jobs: stuck, cancelled, queued, resumed](#jobs-stuck-cancelled-queued-resumed)
- [Error code reference](#error-code-reference)
- [Logs and what to include in a bug report](#logs-and-what-to-include-in-a-bug-report)

---

## First aid

| Symptom | Look at |
|---|---|
| Nothing happens at all | `npm run doctor`, then `npm run status` |
| Something broke after an update | `npm run build`, restart, `npm run doctor` |
| Something broke after moving the folder | Re-run `npm run install-tray` and `npm run install-startup` — shortcuts and the logon task store absolute paths |
| Unclear failures | `%USERPROFILE%\.pi\alfred\logs\` (newest file), plus the dashboard's Model activity panel |

## The bot does not answer

1. **Is the controller running?**
   ```powershell
   npm run status
   ```
   No output / "not running" → `npm run start` (or tray → Start). If it exits immediately, run it
   in the foreground (`npm run dev`) and read the error.

2. **Are you paired?**
   ```powershell
   npm run doctor   # "Owner paired: user <id>"
   ```
   Unpaired looks like: messages are received but everything is ignored. Fix: setup wizard → step 3,
   or `npm run pair`.

3. **Is a webhook blocking long polling?** The setup wizard's step 2 offers **Delete webhook**.
   A configured webhook causes `getUpdates` to fail with a conflict and is the single most common
   "silent bot" cause when you have used this token with another tool before.

4. **Is the token valid?** Doctor checks it live (`Telegram API: authenticated as @your_bot`). If it
   fails, re-enter the token in the wizard. If BotFather revoked it, paste the new one.

5. **Are you sending from the paired account?** Messages from any other Telegram account are
   intentionally ignored. Check `/status` — it prints the owner id.

6. **Rate limiting.** Telegram returns `429` with a retry delay; the outbox backs off automatically.
   Repeated 429s mean another instance of your bot (or a second controller) is polling with the same
   token. `npm run doctor` shows the controller pid.

7. **The bot is blocked or the chat was deleted.** Unblock the bot in Telegram.

## Setup problems

**`Setup Alfred.cmd` closes instantly.** Open PowerShell in the project folder and run:
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
```
The window now stays open with the real error.

**"Node.js was not found" / wrong version.** Install Node 24 LTS from [nodejs.org](https://nodejs.org/)
with default options, close the terminal, retry. `node --version` must print v24.x.

**"Python 3.10+ was not found".** Install Python and tick **Add python.exe to PATH**. Verify with
`python --version`. The `py` launcher is also accepted.

**`npm ci` fails.** Usually a proxy, VPN or corporate TLS inspection:
```powershell
npm config get proxy
npm config set registry https://registry.npmjs.org/
npm ci
```

**Virtual environment install fails.** Antivirus can block `.venv\Scripts\*.exe`. Allow the project
folder (and `%USERPROFILE%\.pi\alfred`), then re-run setup. Deleting `.venv` and re-running is safe.

**Project path contains spaces or non-ASCII characters.** It works — but if a script behaves oddly,
move the project to a simple path such as `C:\Tools\alfred` and re-run setup.

**Build fails after `git pull`.** Delete `node_modules` and `dist`, then `npm ci && npm run build`.

## Pairing problems

**The code expired.** Press **Start pairing** again; codes are single-use and short-lived.

**The wizard does not see my `/start <code>`.** The message must be sent to *your bot*, from the
account you want to pair, while pairing is active. Sending `/start` to BotFather does not count.

**"Wrong account" after accepting.** You accepted a code that came from a different Telegram
account. Pair again from the correct account.

**Re-pairing an existing install.** Send `/start` without a code to the bot — the wizard can then
re-accept the same or a new account; only one owner is supported at a time.

## Model and provider errors

**`MODEL_UNAVAILABLE` / "model not found".** The model id does not exist for that provider, or your
key cannot see it. Test the id in the wizard (it validates against the provider) and switch with
`/model <slot>`.

**401 / invalid key.** Re-enter the key in wizard step 4 or via `/model <slot> <model-id>` +
Configure. Keys are per provider; changing a slot does not change the key.

**402 / insufficient balance.** Add credit at the provider, or switch to a free OpenRouter model or
a local server.

**429 / rate limited.** The job is stopped and reported. Lower `thinking`, use a cheaper model for
simple tasks, or wait for the window to reset.

**Context too large.** Long desktop sessions accumulate big snapshots. Send `/new` to start a fresh
session, and prefer models with a large context window for UI work.

**Model ignores tools / never calls any.** Some chat-only models cannot use tools. Use a model with
tool support (DeepSeek, Claude, GPT, GLM families all work).

**Local server (LM Studio/Ollama) never answers.** Start the server, confirm the base URL
(default LM Studio: `http://127.0.0.1:1234/v1`), and make sure the model id in the slot matches the
id the server exposes (`curl http://127.0.0.1:1234/v1/models`). Local models are slower; raise
`desktop.nativeToolTimeoutMs` only if you truly need to.

**`VISION_UNSUPPORTED`.** The active model cannot accept images. Screenshots are still saved; pick a
vision-capable model to have them interpreted.

**`TOOLS_UNSUPPORTED`.** The provider/endpoint does not expose tool calling. Configure a different
model for that slot.

## Browser errors

**`PROFILE_IN_USE`.** A Chrome window is already using
`%USERPROFILE%\.pi\alfred\browser\profile`. Close it (that includes the window
`scripts\browser-signin.ps1` opens) and resend the task. The agent cannot share a profile with
another Chrome instance — this is a Chrome restriction, not a bug.

**`LOGIN_REQUIRED`.** The site wants a sign-in the profile does not have. Run
`scripts\browser-signin.ps1`, sign in, close the window, retry.

**`CAPTCHA_OR_MFA`.** Google, Cloudflare and banks may challenge an automated browser. Complete the
challenge manually in the visible window while the job is paused, then `/resume`. Do not expect the
agent to solve captchas.

**Chrome does not open at all.** Check `browser.executablePath` in `config.json` and
`browser.headed: true`. If Chrome is installed per-user, point it at
`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`.

**"Browser CLI missing" in the logs.** Run `npm ci` — the browser backend is
`node_modules\@playwright\mcp\cli.js`.

**Downloads, PDFs, screenshots are not where I expect.** They go to
`%USERPROFILE%\.pi\alfred\browser\output\` and are registered as artifacts.

**The window is on a different desktop / monitor.** `npm run doctor` prints displays; the agent uses
the primary display unless a task targets another window. Multi-monitor setups with a negative
coordinate origin can confuse window targeting — move the window to the primary display first.

## Desktop errors

**`DESKTOP_LOCKED`.** The PC is locked or asleep. Unlock it and retry (Telegram commands still work
while locked — only desktop tools are blocked).

**`SECURE_DESKTOP`.** A UAC prompt or Ctrl+Alt+Del screen is up. Dismiss it or approve it manually;
the agent will not pretend to type into a secure desktop.

**`ELEVATION_REQUIRED`.** The task needs administrator rights. Run the app you need as admin
manually, then let the agent continue — it never bypasses UAC.

**`TARGET_NOT_FOUND`.** The element is gone or its accessible name changed. Usually transient: the
agent re-snapshots and retries. If it persists, the app may render custom UI with no accessibility
tree (some Electron/game apps); use keyboard shortcuts or coordinates instead.

**`STALE_OBSERVATION`.** A snapshot got old between planning and acting. The agent takes a fresh one
and continues; on a slow machine raise `desktop.observationMaxAgeMs`.

**`TOOL_TIMEOUT`.** The app took longer than `desktop.nativeToolTimeoutMs`. Close modal dialogs that
block the UI thread, or raise the timeout.

**`HUMAN_TAKEOVER` / "Paused: local input detected".** You touched the mouse or keyboard. This is the
intended safety behaviour: `/resume` to continue, `/stop` to drop the job, or disable
*pause when I use the mouse or keyboard* in Settings.

**`Ctrl+Alt+F9` does nothing.** Another app owns the hotkey. Change `desktop.localStopHotkey` in
Settings (or config) and restart. Doctor reports the current holder while a job is active.

## Dashboard problems

**The page says "Dashboard API error".** The server is not running or the token is wrong. Open it
from the *Alfred* shortcut or `scripts\dashboard-window.ps1`, which inject both.

**401 / "not found" for every request.** The token in the URL is stale (the file was regenerated).
Reread `%USERPROFILE%\.pi\alfred\state\dashboard.json` and use the current values.

**Port already in use.** The port comes from `state\dashboard.json`; the dashboard picks a free port
when it starts. Stale info file → stop the controller and start it again.

**Activity panel does not update.** It uses SSE (`/events`). Corporate proxies and some antivirus
"web shields" buffer `text/event-stream`; exclude `127.0.0.1` from inspection, or just reload the
page.

**The window opens blank.** Chrome refused the app window; open
`http://127.0.0.1:<port>/?token=<token>` in a normal tab to confirm the server is alive.

## Controller, tray and startup problems

**"Another controller is already running (pid …)".** Correct behaviour. Use the running one, or
`npm run stop` first. After a hard crash the lock is stale: the lock is verified against the pid, and
`npm run doctor` tells you whether the process really exists. Delete
`%USERPROFILE%\.pi\alfred\state\controller.lock` only if that pid is gone.

**Startup task does not run.** Check Settings → Startup shows *Running*/*Ready*, and that Task
Scheduler shows the `Alfred` task under your user. The task is per-user and only runs at logon
(there is no Windows service, by design: desktop automation needs an interactive session).

**Tray icon missing after moving the project.** `npm run remove-tray && npm run install-tray` and
the same for startup — both store absolute paths.

**Tray icon is grey / nothing works.** The controller is stopped. Tray → Start. If it fails, the tray
shows the error and the log has the details.

**Two controllers, duplicated replies.** You started a second instance (often a leftover terminal).
`npm run stop`, then start once, or use tray → Restart.

**Right after a Windows or Chrome update.** `npm run doctor`, plus `npm ci` if the browser or
windows-mcp backend misbehaves, then restart.

## Jobs: stuck, cancelled, queued, resumed

**A job asks a question and stays "waiting for owner" after your reply.** Answer in the paired
Telegram chat. Alfred saves the reply to that specific question before waking the worker; another
reply cannot replace the original answer or answer a later question. Expired or cancelled questions
are rejected explicitly. Older builds could say "Answer delivered" without saving it; update,
build, and restart while the controller is idle. Include the job id when reporting a stuck wait.

**A job is stuck "running".** Wait for the watchdog (`jobs.maxRunSeconds`, default 30 min). To stop it
now: `/stop`, `Ctrl+Alt+F9`, or tray → Stop. If the worker ignores an abort, it is killed after
`jobs.stopGraceMs`.

**Cancelling takes a while.** Cancellation is cooperative: the worker finishes the current tool call
so the desktop is not left mid-drag. That is intentional.

**"Queue is full".** `jobs.maxQueued` (default 5) tasks already wait behind the active job. Wait,
`/cancel <jobId>`, or raise the limit in Settings.

**"Paused: waiting for unlock".** The screen locked mid-job. Unlock and `/resume`.

**After a controller crash, jobs say "interrupted".** By design, interrupted jobs are *not*
replayed automatically — half-finished desktop work is rarely safe to repeat. Ask for it again, or
reply referencing the old job, and the model continues as a new linked attempt.

**A job finishes but the reply is empty.** The model returned nothing usable (often a provider
hiccup or a context overflow). Check the usage line in the dashboard for the underlying error, then
retry. If the session file was deleted or moved, the agent starts a fresh session automatically and
notes `SESSION_MISSING` in the log.

**Everything is slow.** Look at the usage line: high `ttft` means provider latency, low `tok/s` means
a slow model or a local server. Switch slots with `/model` and lower `/thinking`.

## Error code reference

| Code | Meaning / usual fix |
|---|---|
| `APPROVAL_REQUIRED` | Action needs your Approve button; nothing is wrong |
| `ARTIFACT_NOT_FOUND` / `ARTIFACT_REJECTED` | The file expired (retention) or was filtered; redo the step |
| `AUTHORIZATION_ERROR` | Token/key rejected — re-enter it in the wizard |
| `BACKEND_ERROR` | A backend crashed; the agent restarts it and retries once |
| `BROWSER_DISCONNECTED` | Chrome died or was closed; the next task relaunches it |
| `CAPTCHA_OR_MFA` | Human step needed in the visible window |
| `CANCELLED` / `PAUSED` | You asked for it |
| `DESKTOP_LOCKED` / `SECURE_DESKTOP` | Unlock the session, dismiss UAC |
| `DRY_RUN` | Expected: `dryRun: true` blocks real changes |
| `ELEVATION_REQUIRED` | The action needs admin; do it manually |
| `HUMAN_TAKEOVER` | Local input detected — `/resume` or `/stop` |
| `INTERNAL_ERROR` | Unexpected; check logs and report with the job id |
| `LEASE_REVOKED` | Another job/human took the desktop lease |
| `LOGIN_REQUIRED` | Sign in via `scripts\browser-signin.ps1` |
| `MODEL_UNAVAILABLE` | Wrong model id, missing key, or provider outage |
| `NOT_IMPLEMENTED` | A tool exists in the schema but has no handler in this build |
| `NO_PROGRESS` | The same step failed repeatedly; job stopped |
| `OUTBOX_ERROR` / `TELEGRAM_ERROR` | Sending failed; the outbox retries with backoff |
| `POLICY_BLOCKED` | Deliberately refused (UAC bypass, credential access, …) |
| `PROFILE_IN_USE` | Close the Chrome window using the agent profile |
| `RATE_LIMITED` | Provider or Telegram limit; wait or switch model |
| `SESSION_UNAVAILABLE` | The session file was missing — a fresh one was started |
| `STALE_OBSERVATION` | Snapshot aged out; retried with a fresh one |
| `TARGET_NOT_FOUND` | UI element changed; the agent re-snapshots |
| `TOOL_TIMEOUT` | Tool exceeded its timeout; see desktop/browser sections |
| `TOOLS_UNSUPPORTED` / `VISION_UNSUPPORTED` | Model lacks tool/vision support — pick another |
| `VALIDATION_ERROR` | A tool was called with bad arguments; the model is told and retries |
| `WORK_LIMIT_REACHED` | Job budget exhausted; split the task or raise the limits |

## Logs and what to include in a bug report

```powershell
# newest log file, redacted by the logger
Get-ChildItem "$env:USERPROFILE\.pi\alfred\logs" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
```

Useful facts to include (never include the bot token or API keys — logs are redacted, your clipboard
is not):

1. What you asked, and the job id (dashboard or `/status`).
2. The error code from the chat reply or the dashboard.
3. Output of `npm run doctor`.
4. The relevant lines from the newest log file.
5. Windows version, Node version, Python version, Chrome version, and the model/thinking level.
