# Configuration reference

Two places hold your settings:

| Where | What | Safe to edit by hand? |
|---|---|---|
| `%USERPROFILE%\.pi\alfred\config.json` | Everything below | Yes — then restart or wait for the controller to pick it up |
| Dashboard → **Settings** | Startup, pause-on-input, hotkey, run/queue limits, retention, theme | Yes, via the UI (writes the same file) |

Secrets are **never** in `config.json`. The bot token and API keys live DPAPI-encrypted in
`%USERPROFILE%\.pi\alfred\secrets\`.

- [Top level](#top-level)
- [Performance settings](performance.md)
- [telegram](#telegram)
- [models](#models)
- [desktop](#desktop)
- [browser](#browser)
- [jobs](#jobs)
- [artifacts](#artifacts)
- [notifications](#notifications)
- [Thinking levels](#thinking-levels)
- [Chat command reference](#chat-command-reference)
- [Local commands and scripts](#local-commands-and-scripts)
- [Data layout](#data-layout)

---

## Top level

| Field | Default | Meaning |
|---|---|---|
| `schemaVersion` | `1` | Config schema; migrations are automatic |
| `dryRun` | `false` | When `true`, tools report what they *would* do and change nothing — the safest way to watch the model plan |
| `dataRoot` | `%USERPROFILE%\.pi\alfred` | Runtime data (database, logs, sessions, artifacts) |
| `workRoot` | `<dataRoot>\work` | Scratch space workers may write in |
| `timeZone` | `UTC` | Zone used for log and usage timestamps |

## telegram

| Field | Default | Meaning |
|---|---|---|
| `tokenSecretName` | `alfred/bot-token` | Name of the DPAPI secret holding the BotFather token |
| `ownerUserId` | `null` | Paired Telegram user id (numeric). Set by pairing; `null` means "not paired" |
| `ownerChatId` | `null` | Paired chat id (numeric) |
| `pollTimeoutSeconds` | `25` | Long-poll window. Lower = more API calls, higher = slightly more latency |
| `allowedUpdates` | `["message","callback_query"]` | Telegram update types that are fetched and processed |

## models

| Field | Default | Meaning |
|---|---|---|
| `authPath` | `%USERPROFILE%\.pi\agent\auth.json` | An existing Pi credential store to reuse, if present. Never modified |
| `baseModelsPath` | `%USERPROFILE%\.pi\agent\models.json` | Extra model definitions from an existing Pi setup |
| `catalogSeedPath` | `%USERPROFILE%\.pi\agent\models-store.json` | Model catalog cache |
| `selectedSlot` | `deepseek` | Slot used for the next job |
| `thinking` | `high` | Global reasoning budget (`low`…`max`) |
| `allowAutomaticModelFallback` | `false` | When `true`, a failed model may fall back to another configured slot |
| `slots` | see below | Named provider+model pairs |

A slot:

```json
"deepseek": {
  "provider": "deepseek",          // deepseek | openrouter | zai | anthropic | openai | lmstudio
  "modelId": "deepseek-flash",     // provider-specific model id
  "label": "DeepSeek V4.1 Flash",  // shown in the wizard and dashboard
  "thinking": "high",              // optional per-slot override of the global level
  "routing": { "only": ["stealth"], "allow_fallbacks": false },   // OpenRouter only
  "requireZeroTokenPrice": true,   // OpenRouter only: refuse paid models
  "endpoint": {                    // local OpenAI-compatible servers only
    "baseUrl": "http://127.0.0.1:1234/v1",
    "api": "openai-completions",
    "apiKey": "lm-studio",
    "models": [
      { "id": "local-model", "name": "Local model", "input": ["text","image"],
        "contextWindow": 32768, "maxTokens": 8192, "reasoning": false }
    ]
  }
}
```

You can have any number of slots; the wizard's **Add a provider** section creates them, and
`/model <slot>` switches the active one from chat. Keys are stored per *provider*, so two slots for
the same provider share one key.

**Choosing a model.** Prefer a model with strong tool use and a large context window: multi-step
desktop work involves long accessibility trees and screenshots. Reasoning support helps for
planning-heavy jobs but slows down trivial ones.

## desktop

| Field | Default | Meaning |
|---|---|---|
| `requireUnlockedSession` | `true` | Refuse desktop tools when the session is locked or on a secure desktop |
| `observationMaxAgeMs` | `60000` | How long a snapshot stays valid before tools demand a fresh one (`STALE_OBSERVATION`) |
| `nativeToolTimeoutMs` | `20000` | Per-call timeout for native desktop tools (`TOOL_TIMEOUT`) |
| `pauseOnObservedHumanInput` | `true` | Pause the job when you touch the mouse or keyboard |
| `localStopHotkey` | `Ctrl+Alt+F9` | Emergency stop, handled locally without Telegram |

## browser

| Field | Default | Meaning |
|---|---|---|
| `executablePath` | Chrome's standard path | Browser binary used for the dedicated profile |
| `profileDir` | `<dataRoot>\browser\profile` | The assistant's own profile — sign in here, never your daily profile |
| `outputDir` | `<dataRoot>\browser\output` | Screenshots, PDFs and downloads captured by browser tools |
| `headed` | `true` | Keep the window visible (recommended: you can watch and intervene) |
| `showActions` | `true` | Overlay the action being performed in the page |

The profile is a real Chrome profile: cookies and sessions persist across restarts, and Chrome
refuses to share it while another window has it open (`PROFILE_IN_USE`).

## jobs

| Field | Default | Meaning |
|---|---|---|
| `maxQueued` | `5` | Tasks allowed to wait behind the active job |
| `maxRunSeconds` | `1800` | Wall-clock budget for one job (`WORK_LIMIT_REACHED`) |
| `maxToolCalls` | `150` | Tool-call budget per job |
| `maxModelTurns` | `60` | Model round-trips per job |
| `maxConsecutiveNoProgress` | `3` | Identical failing steps before the job is stopped (`NO_PROGRESS`) |
| `autoStartMaxAgeSeconds` | `600` | How long an `awaiting_start` job stays confirmable |
| `stopGraceMs` | `3000` | Grace period between abort and kill |

## artifacts

| Field | Default | Meaning |
|---|---|---|
| `retentionDays` | `7` | Age at which artifacts are deleted |
| `maxTotalMiB` | `1024` | Total artifact budget; oldest are removed first |
| `inboundMaxMiB` | `10` | Largest file accepted *from* Telegram |
| `photoTargetMiB` | `4` | Target size when compressing screenshots for chat |
| `sendExactPngOnRequest` | `true` | Send an uncompressed PNG when you ask for an exact screenshot |

## notifications

| Field | Default | Meaning |
|---|---|---|
| `progressMinimumIntervalSeconds` | `15` | Throttle for progress messages |
| `automaticStepScreenshots` | `false` | Attach a screenshot after each major step |
| `completionScreenshot` | `"when-useful"` | `never` \| `when-useful` \| `always` |

## Thinking levels

| Level | Use it for |
|---|---|
| `low` | Trivial lookups and single tool calls |
| `medium` | Everyday tasks |
| `high` (default) | Multi-step work with planning |
| `xhigh` | Long chains, ambiguous requests |
| `max` | Hardest tasks; most expensive in tokens and latency |

Set globally (`models.thinking`), per slot (`slots.<name>.thinking`) or live with
`/thinking <level>`. Providers that do not support reasoning ignore it.

## Chat command reference

| Command | Effect |
|---|---|
| `/help` | Command list |
| `/status` | Active job, queue, model, session, controller state |
| `/pause` / `/resume` | Pause/resume the active job at a safe boundary |
| `/stop` | Cancel the active job |
| `/stop all` | Cancel the active job and everything queued |
| `/queue` | Show queued jobs |
| `/cancel <jobId>` | Cancel one queued job |
| `/run-next` | Start the next queued job now |
| `/screenshot` | Desktop screenshot |
| `/screenshot window` | Focused-window screenshot |
| `/new` | Start a new session (drops model context, keeps job history) |
| `/model` | List slots and the active one |
| `/model <slot>` | Switch the active slot |
| `/model <slot> <model-id>` | Set the model id for a slot |
| `/provider <name>` | Show/select a provider slot |
| `/thinking <level>` | Change the reasoning budget |
| `/tell <instruction>` | Inject guidance into a running job |
| `/approve <id>` / `/reject <id>` | Resolve an approval from the keyboard |
| `/start <code>` | Pairing only |

Anything not starting with `/` is a task for the model. Messages sent while a job is running are
queued (up to `jobs.maxQueued`); `/tell` is the exception — it steers the running job.

## Local commands and scripts

```powershell
# npm scripts
npm run doctor            # environment, session, credentials, pairing, auth
npm run status            # controller status (local IPC)
npm run stop              # graceful shutdown
npm run start             # run the controller in the foreground
npm run dev               # build, then run in the foreground
npm run pair              # pair locally (token is entered hidden)
npm run dashboard         # run the dashboard server
npm run install-startup   # register the logon task
npm run remove-startup    # remove the logon task and older Startup folder shortcuts
npm run install-shortcut  # one Alfred shortcut: starts the agent and opens the dashboard
npm run install-tray      # compatibility alias; does not enable login startup
npm run install-dashboard # compatibility alias for the same Alfred shortcut
npm run remove-tray
npm run tray -- -Action status|start|stop|restart|pause|resume
npm test                  # tsc + unit/integration tests

# PowerShell helpers
scripts\bootstrap.ps1          # the one-click installer behind "Setup Alfred.cmd"
scripts\setup.ps1              # dependencies + build only (developer path)
scripts\dashboard-window.ps1   # open the dashboard as an app window (-Page setup|settings -Theme light|dark)
scripts\browser-signin.ps1     # open the dedicated Chrome profile for manual sign-in
scripts\pair-window.ps1        # pairing UI as an app window
scripts\startup-status.ps1     # report task and Startup folder launch sources
scripts\backup.ps1             # back up config, state and sessions
scripts\doctor.ps1             # same checks as npm run doctor
```

## Data layout

```text
%USERPROFILE%\.pi\alfred\
├── config.json                 # this file, minus secrets
├── secrets\                    # DPAPI blobs: bot token, provider keys
├── state\
│   ├── jobs.sqlite             # jobs, events, usage, telemetry, outbox, approvals
│   ├── controller.lock         # single-instance lock (pid + heartbeat)
│   └── dashboard.json          # dashboard port + access token
├── sessions\                   # Pi SDK conversation files (*.jsonl)
├── agent\                      # generated model catalog + overlay
├── browser\
│   ├── profile\                # dedicated Chrome profile (cookies, logins)
│   └── output\                 # screenshots, PDFs, downloads
├── artifacts\                  # registered artifacts, subject to retention
├── work\                       # scratch space for workers
├── manifests\                  # artifact manifests
└── logs\                       # rotating, redacted logs
```
