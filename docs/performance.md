# Response speed

Alfred keeps the selected model and thinking level. These optimizations are enabled by default and work with existing configuration files:

```json
"performance": {
  "prewarmWorker": true,
  "stripHistoricalToolImages": true
}
```

Restart the controller after changing these settings.

## Desktop work

Clicks, typing, keys, scrolling, dragging, pointer movement and application actions return a fresh observation and screenshot in the same call. The model can use that observation directly for its next action. There is no separate model request just to schedule verification.

An action can include a bounded readiness check:

```json
{
  "action": "launch",
  "executable": "C:\\Windows\\System32\\notepad.exe",
  "waitFor": { "condition": "window", "text": "Notepad", "timeoutMs": 10000 },
  "observation": { "scope": "window", "annotate": false }
}
```

Window and element checks poll without image capture, return as soon as ready, and then capture once. Fixed waits require explicit `ms`. The model is instructed to prefer readiness checks. `observeAfter: false` is available when verification needs to be deferred; another observation is required before the next observed action.

Action, wait and capture share one desktop mutex. Stop, pause and lease checks remain between steps. If the action succeeds but verification fails, the result says `actionOutcome: completed` and explicitly forbids repeating the action. Window capture uses current physical bounds with matching image coordinate transforms and rejects movement during capture.

The pinned Playwright backend writes automatic action snapshots to YAML files. Alfred reads that same bounded snapshot from its configured browser output directory and returns it with the action, avoiding a duplicate snapshot/model call. Chrome remains visible and uses its configured persistent profile.

Browser shutdown closes the persistent context before ending the MCP transport, allowing Chrome to flush recent cookies and login state to the profile.

Named browser screenshots are saved in the configured browser output directory and registered as image artifacts. The tool returns the saved image directly; automatic YAML snapshots cannot be mistaken for screenshot attachments.

## Conversation images

At assignment, the worker freezes an image-free projection of tool results from previous jobs. Text, tool calls/results, reasoning metadata, owner-uploaded images and current-job screenshots stay available. The prefix stays stable throughout the job. This does not change or rewrite the saved transcript.

Original screenshots remain subject to the existing artifact retention policy. `artifact_read_image` can retrieve a registered image from the same owner's conversation when it is needed again. A retrieved screenshot is historical evidence and does not provide a fresh desktop observation.

This setting bounds historical tool-image uploads; it does not summarize or truncate conversation text or discard images within an active task.

## Worker startup

One unused worker imports Pi in advance. It has no job, credentials, session or desktop lease and makes no model requests. Each assigned process runs exactly one job and is terminated afterward. A replacement is prepared for the next task. Only the selected provider's DPAPI key is resolved and injected at assignment. Model and credential changes are read at assignment, so the idle worker has no stale configuration snapshot.

Set `prewarmWorker` to false to trade lower idle memory for a cold start on each job.

## Measurements

`usage_events` now persists full request duration, TTFT, response-opening delay, streaming duration, preparation time and projected context/image sizes. Request timing begins before calling the Pi provider stream, rather than after HTTP response opening. Tool-call deltas count toward streaming timings. Sizes describe the SDK projection, not exact HTTP wire bytes.

Controller logs record worker assignment, warm/cold status, input preparation and session readiness. Explicit finite numeric token metrics are allowed; credentials remain redacted. Compare the same task/model/thinking level and separate cold and warm runs. Changes to an old cached prefix can cause a cache miss on the first request.

## Verification

`npm test` is offline. It includes action verification, stale observations, stop/pause between steps, bounded readiness, historical image projection, artifact ownership and disposable worker lifecycle/failure tests.

Live tests are opt-in and use temporary data/session directories:

- `PI_TG_LIVE_DESKTOP=1`: observation/screenshot tests; `PI_TG_LIVE_DESKTOP_FULL=1` additionally types and saves a temporary Notepad file.
- `PI_TG_LIVE_DEEPSEEK=1`: DeepSeek max-thinking worker smoke tests using the local provider configuration and DPAPI secret, without Telegram delivery.
- `PI_TG_LIVE_BROWSER=1`: visible Chrome with a separate temporary test profile.

Never run a separate live desktop test while the controller is operating the desktop. Shut down the controller first, then restart it after tests.
