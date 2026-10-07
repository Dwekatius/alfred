# Architecture

Alfred is a crash-tolerant, single-user agent runtime for Windows. It is deliberately boring:
one supervisor process, disposable workers, two MCP backends, one SQLite database, and a local
dashboard that reads the same database.

- [Process model](#process-model)
- [Job lifecycle](#job-lifecycle)
- [The worker](#the-worker)
- [Tool broker, policy and approvals](#tool-broker-policy-and-approvals)
- [Backends](#backends)
- [Storage](#storage)
- [Telemetry pipeline](#telemetry-pipeline)
- [Telegram pipeline](#telegram-pipeline)
- [Dashboard](#dashboard)
- [Crash and recovery model](#crash-and-recovery-model)
- [Design decisions worth knowing](#design-decisions-worth-knowing)

---

## Process model

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Controller / supervisor              (one per machine, per user)    │
│                                                                     │
│  Telegram poller ──► admission ──► job queue ──► scheduler          │
│        ▲                                              │             │
│        │                                     WorkerExecutor         │
│  Outbox (retry, rate limits, formatting)              │             │
│                                                       ▼             │
│  Tool broker  ───────────────►  disposable worker process (fork)    │
│    ├─ policy / approval gate         ├─ Pi SDK session              │
│    ├─ desktop lease                  ├─ model runtime overlay       │
│    └─ backends                       └─ streaming callbacks         │
└───────┬───────────────────┬───────────────────────────┬─────────────┘
        │                   │                           │
        ▼                   ▼                           ▼
  windows-mcp         playwright-mcp             SQLite (WAL)
  (stdio, .venv)      (stdio, node)              state/jobs.sqlite
  UI Automation       visible Chrome
```

Everything is in-process except:

- the **worker** (one child process per job, `fork` from `src/pi/worker-executor.ts`),
- **windows-mcp**, launched from the pinned virtual environment
  (`.venv/Scripts/windows-mcp.exe serve`, telemetry disabled),
- **playwright-mcp**, launched from `node_modules/@playwright/mcp/cli.js` with
  `--browser chrome --user-data-dir <dedicated profile>`.

A local CLI and the dashboard talk to the running controller over a small local IPC endpoint
(`state/`), and the lockfile guarantees a single controller per data root.

## Job lifecycle

States are enforced by an explicit transition table (`src/jobs/state-machine.ts`); an illegal
transition throws instead of silently corrupting history.

```text
queued ──► awaiting_start ──► starting ──► running ──┬─► succeeded
   │              │                         │  ▲      ├─► failed
   │              ▼                         │  │      ├─► cancelled
   └──────────► cancelling ◄────────────────┘  │      └─► interrupted
                                    paused ────┘
                            waiting_for_owner ──┘
                            waiting_for_unlock ─┘
```

| State | Meaning |
|---|---|
| `queued` | Admitted and durable, waiting for a free worker |
| `awaiting_start` | Owner asked to confirm before it runs (large/ambiguous request) |
| `starting` | Worker spawned, model session being prepared |
| `running` | Model is working, tools may be in flight |
| `waiting_for_owner` | Blocked on an approval or a clarifying question |
| `waiting_for_unlock` | Desktop locked or a secure desktop is up |
| `paused` | Paused by `/pause`, human-input detection, or the watchdog |
| `cancelling` | Cancellation requested; worker gets a grace period |
| `succeeded` / `failed` / `cancelled` / `interrupted` | Terminal |

Admission is synchronous and durable: every Telegram update is recorded (`updates` table) before
it is acted on, so a crash between "received" and "queued" cannot duplicate a job on restart.
Admission also applies the queue limits (`jobs.maxQueued`) and rejects anything that is not from
the paired owner.

During an active task, short natural-language status checks are durable, high-priority controls;
they do not wait in the job queue. The supervisor sends bounded activity updates for long tasks
without forwarding model reasoning. On controller restart, every previous active worker state
(including paused and waiting) becomes interrupted; no old job is presented as resumable without a worker.

## The worker

One process per job, forked, never reused. It receives a `start_job` message and owns:

- a Pi SDK **session** (`sessions/*.jsonl`) — a conversation file that persists context across
  jobs until you send `/new`;
- a **model runtime overlay** built from your slots, so a slot switch affects the next worker only;
- **API keys injected in memory** — the worker never reads the DPAPI store or the Pi auth file
  directly;
- the **Pi SDK tool loop**, with Alfred's tool schemas (`src/pi/tool-definitions.ts`);
- **hard limits**: `maxRunSeconds`, `maxToolCalls`, `maxModelTurns`, `maxConsecutiveNoProgress`.

It streams to the supervisor over IPC:

| Message | Purpose |
|---|---|
| `ready` | Session is up (carries the session file path → persisted for reuse) |
| `stream` | Thinking/answer deltas plus `thinking_end`/`answer_end` boundaries |
| `tool_request` | A tool call to be routed through the broker |
| `tool_result` | Result of a brokered call, back into the model loop |
| `usage` | Per-turn counters (model turns, tool calls) |
| `model_usage` | Exact provider usage for one response: tokens, cache, cost |
| `progress` | Human-readable progress for Telegram |
| `image` | An artifact produced by a tool |
| `settled` | Final state + final answer text |
| `fatal` | Worker died with a reason |

Cancellation is cooperative first (`abort` message), then a signal, then a kill after
`jobs.stopGraceMs`. The supervisor always records *why* a job ended.

## Tool broker, policy and approvals

The worker cannot touch your machine directly. Every tool call goes through
`src/tools/broker.ts`, which:

1. **Classifies** the call (read-only, write, destructive, interactive, network).
2. **Checks policy** — `dryRun`, per-job budgets, tool allowlists, and whether the action needs
   approval.
3. **Takes the desktop lease** when a tool drives UI, so two jobs can never fight over the mouse.
4. **Runs the handler** (desktop, browser, files, PowerShell, Telegram, artifacts) with a timeout.
5. **Records** the call, duration, outcome and artifact references.
6. **Returns** a structured result (or a structured error with one of the codes in
   `src/tools/errors.ts`, e.g. `APPROVAL_REQUIRED`, `PROFILE_IN_USE`, `DESKTOP_LOCKED`,
   `TARGET_NOT_FOUND`, `CAPTCHA_OR_MFA`, `RATE_LIMITED`).

Approvals and questions are rows in the database (`approvals`, `questions`) and messages in chat
with inline buttons; the job moves to `waiting_for_owner` until the owner answers. A rejection is
reported back to the model as a refusal, so it adapts instead of retrying blindly.

## Backends

| Backend | Process | Used for |
|---|---|---|
| **windows-mcp** | `.venv` stdio server | Launch/activate apps, accessibility tree snapshots, mouse, keyboard, screenshots, window state |
| **WindowsHelper** | in-process (PowerShell bridge) | Desktop lock state, session checks, focused window, input watch, DPI, hotkeys |
| **playwright-mcp** | `node_modules` stdio server | A visible Chrome window: navigate, click, type, evaluate, screenshot, PDF, tabs |
| **files** | in-process | Workspace-scoped read/write/list with size limits and path checks |
| **PowerShell** | child process | Commands with timeouts, captured output, no interactive prompts |
| **artifacts** | in-process | Registration, retention, thumbnails, Telegram upload |

The browser backend pins the *dedicated profile*
(`%USERPROFILE%\.pi\alfred\browser\profile`) and an output directory for screenshots
(`browser.outputDir`). It never opens the browser profile used by your own Chrome.

## Storage

SQLite in WAL mode at `%USERPROFILE%\.pi\alfred\state\jobs.sqlite`, schema versioned by
`src/storage/migrations.ts` (current version 5). Tables:

| Table | Contents |
|---|---|
| `jobs`, `job_events` | Every job and its state history |
| `conversations` | The owner conversation and its session file |
| `updates` | Telegram update cursor and admission decisions (exactly-once) |
| `outbox` | Outgoing messages, attempts, dedupe keys, delivery state |
| `approvals`, `questions` | Owner interactions and their resolution |
| `controls` | Local/remote control commands (`stop_all`, `pause`, …) |
| `artifacts` | Registered files: path, kind, size, hash, expiry |
| `usage_events` | Token/cost/rate rows used by the dashboard charts |
| `stream_events` | Aggregated thinking/answer blocks and tool/state/usage lines |
| `pairing` | One-time pairing codes and their state |
| `meta` | Migration and controller metadata |

Migrations are forward-only and run at startup inside a transaction. Telemetry is pruned to
24 hours / 20 000 rows; artifacts expire per `artifacts.retentionDays` and `maxTotalMiB`.

## Telemetry pipeline

The dashboard is a live view of work in progress, so the pipeline is push-based and idempotent:

```text
worker deltas ──► supervisor.recordStream() ──► in-memory buffer
                                                   │  every 300 ms (or 200 entries)
                                                   ▼
                                   SQLite stream_events rows
                                        (one row per block)
                                                   │
                              SELECT … WHERE id > ? OR updated_at > ?
                                                   ▼
                                   GET /events (SSE, 250 ms poll)
                                                   │
                              client merges by row id, never duplicates
```

Rules that make the terminal readable:

- **One row per contiguous block.** A whole thinking chain is a single row whose `text` grows;
  same for an answer. Blocks are closed by explicit `thinking_end` / `answer_end` markers (or by a
  switch to the other kind), so a partially flushed block is never split in two — the close is
  applied at flush time, in order.
- **`updated_at` drives updates.** The client merges by id and re-renders changed rows, so live
  deltas and a page reload show the same history.
- **Durations come from row timestamps** (`timestamp` → `updated_at`), so a block shows a real
  duration after a reload instead of a client-side stopwatch.
- **Usage lines are single rows.** `deepseek/deepseek-flash — in=185 · out=111 · reasoning=34 ·
  cache=6,144 · 210.2 tok/s · ttft 0.2s · wall 0.7s · $0.00023`.
- **TPS is decode throughput**, measured in the worker as
  `outputTokens ÷ (lastDelta − firstDelta)`, excluding prefill — and it is shown only for a
  *completed* response, so the number never drifts while text is still arriving.

`usage_events` feeds the cost/token charts; `stream_events` feeds the terminal.

## Telegram pipeline

- **Poller** — `getUpdates` long polling with a durable cursor (`updates.receive_cursor`). A
  configured webhook is detected and reported (the setup wizard can delete it), because a webhook
  and long polling cannot coexist.
- **Admission** — synchronous, per update, inside a transaction: record, decide
  (accept/duplicate/reject), push to the queue. No async work between "received" and "durable".
- **Commands** — parsed deterministically (`src/telegram/commands.ts`) and handled by the
  supervisor. They are never handed to the model as task text.
- **Outbox** — every outgoing message is a row with a dedupe key and attempt counter. Sending is
  retried with backoff; Telegram rate limits are respected; long answers are chunked; progress
  messages are throttled (`notifications.progressMinimumIntervalSeconds`).
- **Formatting** — `src/telegram/format.ts` renders Markdown safely (escaping, chunk limits) and
  converts artifacts into photos/documents with the right size caps.

## Dashboard

`src/dashboard.ts` serves a small static app (`dashboard/`, no framework, no build step) plus a
JSON API. Access requires the per-install token (`state/dashboard.json`) — either as `?token=` or
as a header — and the server binds to `127.0.0.1` only.

| Route | Purpose |
|---|---|
| `GET /api/status` | Controller state, active job, queue, model, session, scheduled-task state |
| `GET /api/usage` | Bucketed token/cost series for the charts |
| `GET /api/settings`, `POST /api/settings` | Read/write the curated settings |
| `POST /api/action` | `start`, `stop`, `restart`, `pause`, `resume` (exactly what the tray does) |
| `POST /api/clear` | Clear terminal telemetry |
| `GET /events` | SSE: replay of the last 200 stream rows, then live deltas |
| `/api/setup/*` | Setup wizard: token verify, pairing, key validation, slots, browser sign-in |
| `/api/settings/startup` | Register/remove the logon task |
| `/` + `/app.js`, `/style.css`, `/logo*.png` | Static app |

## Crash and recovery model

- **Single instance.** `state/controller.lock` contains the pid and is refreshed periodically;
  a second controller refuses to start (and the doctor reports the holder).
- **Crash-only software.** Jobs that were mid-flight when the process died are marked
  `interrupted` at startup and reported to the owner as *not* replayed automatically — resuming is
  an explicit decision, because half-done desktop work is rarely safe to repeat blindly.
- **Backends are restartable.** A crashed windows-mcp or playwright-mcp connection is torn down
  and restarted with an explicit error surfaced to the job.
- **Worker death is contained.** The supervisor receives `fatal`, marks the job failed with the
  reason, and moves on; the next job gets a fresh process.
- **Telemetry cannot break a job.** Stream flushing, pruning and dashboard writes are best-effort
  and never throw into the job path.

## Design decisions worth knowing

**Why not Docker?** Alfred's entire value is driving *your* interactive Windows desktop and a
*visible* Chrome window as *you*. Linux containers have no Windows desktop; Windows containers
have no GUI session. Containerising would leave a headless HTTP tool, not this product.

**Why a disposable worker per job?** Model SDKs accumulate state (sessions, tool registries,
timers). A fresh process makes cancellation reliable, leaks impossible, and a crash survivable.
The cost — process startup, a few hundred milliseconds — is irrelevant next to a model call.

**Why SQLite instead of files?** The queue, exactly-once admission, approvals, outbox retries and
telemetry all need transactions. WAL mode gives that with zero servers to run.

**Why long polling?** A home PC has no stable public address, and a webhook would mean exposing a
port. Polling costs one cheap HTTPS request per 25 seconds and works behind any NAT.

**Why is the model allowed to see tool errors verbatim?** Because that is how it recovers. A
structured error (`PROFILE_IN_USE`, `TARGET_NOT_FOUND`, `CAPTCHA_OR_MFA`) tells the model to change
strategy instead of retrying the same broken step.
