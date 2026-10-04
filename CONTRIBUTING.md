# Contributing to Alfred

Thanks for taking a look. Alfred is a Windows-only, single-user agent runtime; the most useful
contributions are reliability fixes, better tool coverage, provider support and documentation.
Please open an issue before starting anything large so we do not duplicate work.

- [Development setup](#development-setup)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Conventions](#conventions)
- [Adding a tool](#adding-a-tool)
- [Adding a model provider or slot](#adding-a-model-provider-or-slot)
- [Pull requests](#pull-requests)
- [Security](#security)
- [License](#license)

---

## Development setup

**Requirements:** Windows 10/11, Node.js 24.15.x, Python 3.10+ (3.14 tested), Google Chrome.

```powershell
git clone https://github.com/Dwekatius/alfred.git
cd alfred
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup.ps1
npm run doctor
npm run dev        # controller in the foreground, dashboard available
```

`scripts\setup.ps1` creates `.venv`, installs `python\requirements.lock.txt`, runs `npm ci`, copies
`config.example.json` to `%USERPROFILE%\.pi\alfred\config.json` when missing, and builds.

For iterating on the dashboard, nothing needs building: `src/dashboard.ts` reads the static files
in `dashboard/` from disk on every request.

Never commit `.venv`, `node_modules`, `dist`, real config files, or anything under
`%USERPROFILE%\.pi\alfred`. They are in `.gitignore`; please keep it that way.

## Tests

```powershell
npm test            # build + unit + integration (68 tests; 6 skipped by default)
npm run test:unit
npm run typecheck
```

Unit tests use fixtures and in-memory/temporary databases — no network, no desktop, no Chrome.
The skipped integration tests are opt-in live gates that touch real resources:

```powershell
$env:PI_TG_LIVE_DEEPSEEK = "1"; node --test dist/tests/integration/live-worker.test.js
$env:PI_TG_LIVE_DESKTOP  = "1"; node --test dist/tests/integration/live-desktop.test.js
$env:PI_TG_LIVE_BROWSER  = "1"; node --test dist/tests/integration/live-browser.test.js
```

Rules for tests:

- A new bug fix comes with a regression test that fails before the fix.
- Telemetry/streaming changes must extend `tests/unit/stream-aggregation.test.ts`.
- State machine changes must extend `tests/unit/state-machine.test.ts` (illegal transitions must
  keep throwing).
- Never call a real provider from a default test run.

## Project layout

| Path | Responsibility |
|---|---|
| `src/main.ts` | Entry point: config, lock, supervisor, shutdown |
| `src/supervisor.ts` | Orchestration, admission, queue, approvals, telemetry |
| `src/pi/worker-executor.ts` | Fork, supervise and cancel workers |
| `src/pi/worker-main.ts` | Inside the worker: Pi SDK session, streaming, usage |
| `src/pi/catalog.ts`, `src/pi/models.ts` | Model catalog, slot resolution, runtime overlay |
| `src/tools/broker.ts` | Policy, approvals, leases, tool routing |
| `src/tools/*` | Backends: windows-mcp, playwright-mcp, files, PowerShell, artifacts |
| `src/jobs/*` | Repository, state machine, scheduler, approvals, questions |
| `src/storage/*` | SQLite connection, schema, forward-only migrations |
| `src/telegram/*` | Poller, admission helpers, outbox, formatting, media |
| `src/dashboard.ts` + `dashboard/` | Local UI and its JSON/SSE API |
| `src/setup.ts`, `src/settings.ts` | Setup wizard and settings logic |
| `src/doctor.ts`, `src/local-cli.ts` | Diagnostics and local control |
| `scripts/*.ps1` | Installers, tray, backup, doctor, browser sign-in |
| `python/` | Pinned backends plus the DPAPI helper |

## Conventions

- **TypeScript, ESM, strict.** No `any` without a comment explaining why. Prefer explicit result
  types on public functions.
- **No new runtime dependencies** without a discussion — the dependency surface is deliberately
  small (Pi SDK, MCP SDK, Playwright MCP, `sharp`, `typebox`).
- **Failures are structured.** Throw `AgentToolError` with a code from `src/tools/errors.ts`, and an
  outcome (`not_started` / `unknown`) that tells the model whether it is safe to retry. Never invent
  a new code without documenting it in `docs/troubleshooting.md`.
- **Never log secrets.** Pass user/tool text through the logger's redaction; assume every string may
  end up in a log file.
- **Migrations are forward-only.** Add a new version in `src/storage/migrations.ts`; never edit an
  existing one. Include a short comment explaining the change.
- **Telemetry cannot break a job.** Dashboard, stream flushing and pruning are best-effort: catch,
  log at debug level, continue.
- **The dashboard stays framework-free.** Plain HTML/CSS/JS, no build step, works offline.
- **Every Telegram command is parsed deterministically** in `src/telegram/commands.ts`; it must never
  reach the model as task text.
- **Keep it honest.** No fake progress, no swallowed errors, no placeholder text in UI.

## Adding a tool

1. Add the schema in `src/pi/tool-definitions.ts` with a precise description — the model only knows
   what the description says.
2. Register the handler in `src/tools/broker.ts` and classify it (read-only, reversible,
   sensitive, destructive). Sensitive and destructive actions must go through the approval gate.
3. If it drives UI, take the desktop lease so jobs cannot fight over input.
4. Return structured errors (`TARGET_NOT_FOUND`, `TOOL_TIMEOUT`, …) instead of raw exceptions.
5. Register artifacts you produce (so retention and Telegram upload work).
6. Add tests: a broker routing test, plus a live gate test if it touches the real desktop/browser.
7. Document it in `docs/architecture.md` (backend table) if it introduces a new backend.

## Adding a model provider or slot

1. Add the provider to `src/pi/catalog.ts` with its models, pricing and thinking levels.
2. If the provider needs a key, teach the setup wizard how to validate it
   (`src/setup.ts` — one live call, clear error messages).
3. Extend the slot editing API and the dashboard's slot cards if the provider needs extra fields
   (routing, endpoint, API style).
4. Update `config.example.json`, `docs/configuration.md` and `docs/troubleshooting.md`.
5. Test with `dryRun: true` first, then one real task, and note the model's tool-use behaviour in
   the PR.

## Pull requests

- One topic per PR; keep diffs reviewable.
- Describe **what you tested** — including whether you ran a live gate — and paste the relevant
  output.
- Run `npm run typecheck && npm test` before pushing.
- Update documentation and `config.example.json` when behaviour changes.
- Do not include secrets, personal identifiers, machine-specific paths, or screenshots of a real
  desktop without redacting private content.
- Prefix commit messages with the area when it helps: `worker:`, `broker:`, `telegram:`,
  `dashboard:`, `docs:`, `fix:`.

## Security

Please read [SECURITY.md](SECURITY.md) before reporting anything that could let a third party
control someone's machine. Do not open a public issue for those.

## License

By contributing you agree that your work is licensed under the MIT license of this repository, and
you confirm you have the right to submit it (no copied code from incompatible licenses).
