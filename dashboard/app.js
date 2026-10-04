/* Alfred dashboard */
(() => {
  const token = window.PI_TOKEN;
  const $ = (id) => document.getElementById(id);

  const state = {
    metric: "cost",
    bucket: "day",
    usage: null,
    controllerRunning: false,
    activeJob: null,
    chart: { buckets: [], geometry: null },
  };

  // ---------------------------------------------------------------- theme

  const THEME_KEY = "pi-theme";
  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

  function currentThemeMode() {
    return localStorage.getItem(THEME_KEY) || "system";
  }

  function applyTheme(mode) {
    const resolved = mode === "dark" || (mode === "system" && themeMedia.matches) ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", resolved);
    document.documentElement.setAttribute("data-theme-mode", mode);
    localStorage.setItem(THEME_KEY, mode);
    for (const segment of document.querySelectorAll(".theme-seg")) {
      for (const button of segment.querySelectorAll("button")) button.classList.toggle("active", button.dataset.theme === mode);
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", resolved === "dark" ? "#0b0b0c" : "#ffffff");
    const favicon = $("faviconLink");
    if (favicon) favicon.setAttribute("href", resolved === "dark" ? "/favicon-dark.png" : "/favicon.png");
    if (state.chart.buckets.length) drawChart();
  }

  for (const segment of document.querySelectorAll(".theme-seg")) {
    segment.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (button) applyTheme(button.dataset.theme);
    });
  }
  themeMedia.addEventListener("change", () => {
    if (currentThemeMode() === "system") applyTheme("system");
  });
  applyTheme(currentThemeMode());

  // ---------------------------------------------------------------- helpers

  async function api(path, options = {}) {
    const url = new URL(path, window.location.origin);
    url.searchParams.set("token", token);
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.body ? { "content-type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  }

  function fmtUsd(value) {
    const number = Number(value ?? 0);
    if (number === 0) return "$0.00";
    if (number < 0.0001) return `$${number.toFixed(6)}`;
    if (number < 0.01) return `$${number.toFixed(4)}`;
    if (number < 1) return `$${number.toFixed(3)}`;
    return `$${number.toFixed(2)}`;
  }

  function fmtTokens(value) {
    const number = Number(value ?? 0);
    if (number >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
    if (number >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
    if (number >= 1e3) return `${(number / 1e3).toFixed(1)}k`;
    return String(Math.round(number));
  }

  function fmtMetric(costUsd, tokens) {
    return state.metric === "cost" ? fmtUsd(costUsd) : `${fmtTokens(tokens)} tok`;
  }

  function setHint(text) {
    $("actionHint").textContent = text ?? "";
    if (text) setTimeout(() => { if ($("actionHint").textContent === text) $("actionHint").textContent = ""; }, 4000);
  }

  // ---------------------------------------------------------------- status

  async function refreshStatus() {
    try {
      const status = await api("/api/status");
      const controller = status.controller;
      state.controllerRunning = Boolean(status.controllerRunning);
      state.activeJob = controller?.activeJob ?? null;

      const dot = $("statusDot");
      dot.className = "dot";
      if (controller?.stopping) dot.classList.add("attention");
      else if (state.activeJob) dot.classList.add("busy");
      else if (state.controllerRunning) dot.classList.add("running");
      else dot.classList.add("stopped");

      // Windows scheduled-task state: Ready/Running/Disabled, or unknown when the
      // autostart task is not installed (the assistant is run by hand).
      const serviceState = String(status.taskState ?? "");
      const serviceLabel = /^Ready$/i.test(serviceState) ? "ready" : /^Running$/i.test(serviceState) ? "running" : /^Disabled$/i.test(serviceState) ? "disabled" : "not installed";

      $("statusText").textContent = state.activeJob
        ? `Working on ${state.activeJob.id} · ${state.activeJob.label ?? ""}`
        : state.controllerRunning
          ? `Running and idle · ${status.queued ?? 0} queued`
          : `Stopped · service ${serviceLabel}`;

      $("modelChip").innerHTML = `model <strong>${status.model.modelId}</strong> · ${status.model.thinking}`;
      $("pairedChip").innerHTML = status.paired ? "paired" : "<strong>not paired</strong>";
      $("taskChip").innerHTML = `service <strong>${serviceLabel}</strong>`;

      const primary = $("primaryBtn");
      if (state.controllerRunning) {
        primary.textContent = "Stop assistant";
        primary.classList.add("stop");
      } else {
        primary.textContent = "Start assistant";
        primary.classList.remove("stop");
      }
      $("pauseBtn").disabled = !state.activeJob;
      $("resumeBtn").disabled = !state.activeJob || state.activeJob.state !== "paused";
      $("footerInfo").textContent = `local dashboard · 127.0.0.1 · ${new Date(status.time).toLocaleTimeString()}`;
    } catch (error) {
      $("statusText").textContent = `Dashboard API error: ${error.message}`;
    }
  }

  async function runAction(action) {
    const labels = { start: "Starting assistant…", stop: "Stopping assistant…", restart: "Restarting…", pause: "Pausing…", resume: "Resuming…" };
    setHint(labels[action] ?? action);
    try {
      const result = await api("/api/action", { method: "POST", body: { action } });
      setHint(result.message ?? (result.ok ? "done" : "failed"));
    } catch (error) {
      setHint(`Action failed: ${error.message}`);
    }
    await refreshStatus();
  }

  $("primaryBtn").addEventListener("click", () => runAction(state.controllerRunning ? "stop" : "start"));
  $("restartBtn").addEventListener("click", () => runAction("restart"));
  $("pauseBtn").addEventListener("click", () => runAction("pause"));
  $("resumeBtn").addEventListener("click", () => runAction("resume"));

  // ---------------------------------------------------------------- terminal

  const terminal = $("terminal");
  const emptyState = $("termEmpty");
  const blocks = new Map();
  const openThinkingByJob = new Map();
  const openAnswerByJob = new Map();

  function rowTime(value) {
    const parsed = Date.parse(String(value ?? ""));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  function durationSeconds(handle) {
    const end = handle.lastUpdate ?? Date.now();
    const start = handle.startedAt ?? handle.lastUpdate ?? Date.now();
    return Math.max(0, (end - start) / 1000);
  }

  function removeEmptyState() {
    if (emptyState && emptyState.parentElement) emptyState.remove();
  }
  function autoscroll() {
    if ($("autoscroll").checked) terminal.scrollTop = terminal.scrollHeight;
  }
  function trimTerminal() {
    while (terminal.childElementCount > 400) terminal.removeChild(terminal.firstElementChild);
  }
  function formatChars(count) {
    return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
  }

  function createTextBlock(row) {
    const isThinking = row.kind === "thinking";
    const root = document.createElement("div");
    root.className = `block ${isThinking ? "thinking" : "answer"} streaming`;
    const head = document.createElement("button");
    head.type = "button";
    head.className = "block-head";
    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = isThinking ? "▾" : "";
    const label = document.createElement("span");
    label.className = "block-label";
    label.textContent = isThinking ? "think" : "answer";
    const stats = document.createElement("span");
    stats.className = "block-stats";
    head.append(chevron, label, stats);
    const body = document.createElement("pre");
    body.className = "block-body";
    root.append(head, body);
    if (isThinking) {
      head.addEventListener("click", () => {
        root.classList.toggle("collapsed");
        chevron.textContent = root.classList.contains("collapsed") ? "▸" : "▾";
      });
    }
    terminal.appendChild(root);
    const handle = { id: Number(row.id), jobId: row.job_id ?? "controller", kind: row.kind, root, chevron, stats, body, text: "", streaming: true, open: true, startedAt: rowTime(row.timestamp) ?? Date.now(), lastUpdate: rowTime(row.updated_at) ?? Date.now() };
    blocks.set(handle.id, handle);
    return handle;
  }

  function updateStats(handle) {
    const seconds = durationSeconds(handle);
    const suffix = handle.streaming ? " · streaming" : seconds >= 0.05 ? ` · ${seconds.toFixed(1)}s` : "";
    handle.stats.textContent = `${formatChars(handle.text.length)} chars${suffix}`;
  }

  function finishBlock(handle) {
    if (!handle || !handle.streaming) return;
    handle.streaming = false;
    handle.root.classList.remove("streaming");
    updateStats(handle);
  }

  function updateTextBlock(row) {
    let handle = blocks.get(Number(row.id));
    if (!handle) handle = createTextBlock(row);
    const text = String(row.text ?? "");
    handle.lastUpdate = rowTime(row.updated_at) ?? Date.now();
    if (text !== handle.text) {
      handle.text = text;
      handle.body.textContent = text;
    }
    if (handle.kind === "answer") handle.root.classList.remove("streaming");
    updateStats(handle);
    trimTerminal();
    autoscroll();
    return handle;
  }

  function closeThinkingBlock(jobId) {
    const handle = openThinkingByJob.get(jobId);
    if (!handle || !handle.open) return;
    openThinkingByJob.delete(jobId);
    handle.open = false;
    handle.root.classList.add("collapsed");
    handle.chevron.textContent = "▸";
    finishBlock(handle);
  }

  function appendLine(kind, text, jobId) {
    if (jobId) closeThinkingBlock(jobId);
    if (!text) return;
    removeEmptyState();
    const line = document.createElement("span");
    line.className = `line ${kind}`;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = kind === "usage" ? "usage" : kind;
    const body = document.createElement("span");
    body.className = "text";
    body.textContent = text;
    line.append(tag, body);
    terminal.appendChild(line);
    trimTerminal();
    autoscroll();
  }

  function handleStreamRow(row) {
    const kind = String(row.kind ?? "state");
    const jobId = row.job_id ?? "controller";
    if (kind === "thinking") {
      const handle = updateTextBlock(row);
      if (handle) openThinkingByJob.set(jobId, handle);
      return;
    }
    if (kind === "thinking_end") {
      closeThinkingBlock(jobId);
      return;
    }
    if (kind === "answer") {
      closeThinkingBlock(jobId);
      const handle = updateTextBlock(row);
      if (handle) openAnswerByJob.set(jobId, handle);
      return;
    }
    if (kind === "answer_end") {
      finishBlock(openAnswerByJob.get(jobId));
      openAnswerByJob.delete(jobId);
      return;
    }
    if (kind === "usage") showUsageReadout(String(row.text ?? ""));
    appendLine(kind, String(row.text ?? ""), jobId);
  }

  /** The exact decode rate comes from the usage line of the last completed response. */
  function showUsageReadout(text) {
    const readout = $("tpsReadout");
    if (!readout) return;
    const rate = /([\d.]+) tok\/s/.exec(text);
    const ttft = /ttft ([\d.]+)s/.exec(text);
    const wall = /wall ([\d.]+)s/.exec(text);
    if (!rate) {
      readout.textContent = "TPS —";
      readout.classList.remove("has-value");
      return;
    }
    readout.textContent = `TPS ${rate[1]}`;
    readout.classList.add("has-value");
    readout.title = ["Decode tokens per second of the last completed response", ttft ? `ttft ${ttft[1]}s` : null, wall ? `wall ${wall[1]}s` : null].filter(Boolean).join(" · ");
  }

  /** Close blocks whose end marker never arrived. */
  function cleanupBlocks() {
    const now = Date.now();
    for (const [jobId, handle] of openThinkingByJob) {
      if (now - (handle.lastUpdate ?? now) > 5000) closeThinkingBlock(jobId);
    }
    for (const [jobId, handle] of openAnswerByJob) {
      if (now - (handle.lastUpdate ?? now) > 5000) {
        finishBlock(handle);
        openAnswerByJob.delete(jobId);
      }
    }
  }
  setInterval(cleanupBlocks, 1000);

  function applyFilters() {
    terminal.classList.toggle("hide-thinking", !$("showThinking").checked);
    terminal.classList.toggle("hide-answer", !$("showAnswers").checked);
    terminal.classList.toggle("hide-tool", !$("showTools").checked);
    autoscroll();
  }
  for (const id of ["showThinking", "showAnswers", "showTools"]) $(id).addEventListener("change", applyFilters);

  $("clearBtn").addEventListener("click", async () => {
    try { await api("/api/clear", { method: "POST" }); } catch { /* ignore */ }
    terminal.innerHTML = "";
    blocks.clear();
    openThinkingByJob.clear();
    openAnswerByJob.clear();
    terminal.appendChild(emptyState);
    const readout = $("tpsReadout");
    if (readout) { readout.textContent = "TPS —"; readout.classList.remove("has-value"); }
  });

  function connectEvents() {
    const source = new EventSource(`/events?token=${encodeURIComponent(token)}`);
    source.onmessage = (event) => {
      try {
        handleStreamRow(JSON.parse(event.data));
      } catch { /* ignore malformed */ }
    };
    source.onerror = () => {
      // EventSource reconnects automatically; nothing to do.
    };
  }

  // ---------------------------------------------------------------- chart

  const canvas = $("chart");
  const tooltip = $("tooltip");
  const ctx = canvas.getContext("2d");
  /** Theme-aware chart palette read from CSS custom properties. */
  function chartColors() {
    const styles = getComputedStyle(document.documentElement);
    const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
    return {
      input: read("--chart-input", "#111111"),
      output: read("--chart-output", "#c7c7c7"),
      cost: read("--chart-cost", "#2563eb"),
      grid: read("--chart-grid", "#efefef"),
      axis: read("--chart-axis", "#9a9a9a"),
      text: read("--chart-axis", "#9a9a9a"),
    };
  }

  function niceMax(value) {
    if (value <= 0) return 1;
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const normalized = value / magnitude;
    const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    return step * magnitude;
  }

  function drawChart() {
    const COLORS = chartColors();
    const buckets = state.chart.buckets;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 400;
    const cssHeight = canvas.clientHeight || 250;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const padL = 56, padR = 10, padT = 14, padB = 30;
    const plotW = Math.max(10, cssWidth - padL - padR);
    const plotH = Math.max(10, cssHeight - padT - padB);

    const values = buckets.map((bucket) => (state.metric === "cost" ? Number(bucket.costUsd) : Number(bucket.inputTokens) + Number(bucket.outputTokens)));
    const rawMax = Math.max(...values, state.metric === "cost" ? 0.005 : 100);
    const max = niceMax(rawMax * 1.1);

    // Grid + y labels
    ctx.font = "11px Segoe UI, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const divisions = 4;
    for (let index = 0; index <= divisions; index += 1) {
      const value = (max / divisions) * index;
      const y = padT + plotH - (value / max) * plotH;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.fillText(state.metric === "cost" ? fmtUsd(value) : fmtTokens(value), padL - 8, y);
    }

    if (buckets.length === 0) {
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = "center";
      ctx.fillText("No usage recorded yet.", padL + plotW / 2, padT + plotH / 2);
      return;
    }

    const slot = plotW / buckets.length;
    const barWidth = Math.max(4, Math.min(38, slot * 0.62));
    const labelEvery = Math.ceil(buckets.length / 10);

    state.chart.geometry = { padL, padT, plotW, plotH, slot, barWidth, max };
    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index];
      const x = padL + slot * index + (slot - barWidth) / 2;
      const bottom = padT + plotH;
      if (state.metric === "cost") {
        const height = max > 0 ? (Number(bucket.costUsd) / max) * plotH : 0;
        if (height > 0.5) {
          ctx.fillStyle = COLORS.cost;
          roundRect(ctx, x, bottom - height, barWidth, height, 2);
          ctx.fill();
        }
      } else {
        const inputHeight = max > 0 ? (Number(bucket.inputTokens) / max) * plotH : 0;
        const outputHeight = max > 0 ? (Number(bucket.outputTokens) / max) * plotH : 0;
        if (inputHeight > 0.5) {
          ctx.fillStyle = COLORS.input;
          roundRect(ctx, x, bottom - inputHeight, barWidth, inputHeight, 2);
          ctx.fill();
        }
        if (outputHeight > 0.5) {
          ctx.fillStyle = COLORS.output;
          roundRect(ctx, x, bottom - inputHeight - outputHeight, barWidth, outputHeight, 2);
          ctx.fill();
        }
      }
      if (index % labelEvery === 0) {
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(bucket.label, padL + slot * index + slot / 2, bottom + 8);
      }
    }
    ctx.textBaseline = "middle";
  }

  function roundRect(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  canvas.addEventListener("mousemove", (event) => {
    const geometry = state.chart.geometry;
    const buckets = state.chart.buckets;
    if (!geometry || buckets.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const index = Math.floor((x - geometry.padL) / geometry.slot);
    if (index < 0 || index >= buckets.length || y < geometry.padT || y > geometry.padT + geometry.plotH) {
      tooltip.classList.add("hidden");
      return;
    }
    const bucket = buckets[index];
    tooltip.innerHTML = [
      `<b>${bucket.label}</b>`,
      `input: ${fmtTokens(bucket.inputTokens)}`,
      `output: ${fmtTokens(bucket.outputTokens)}`,
      bucket.reasoningTokens ? `reasoning: ${fmtTokens(bucket.reasoningTokens)}` : null,
      bucket.cacheReadTokens ? `cache read: ${fmtTokens(bucket.cacheReadTokens)}` : null,
      `cost: ${fmtUsd(bucket.costUsd)}`,
    ].filter(Boolean).join("<br/>");
    tooltip.classList.remove("hidden");
    const left = Math.min(x + 14, cssWidthMinus(rect.width, tooltip.offsetWidth));
    tooltip.style.left = `${Math.max(4, left)}px`;
    tooltip.style.top = `${Math.max(4, y - tooltip.offsetHeight - 10)}px`;
  });
  canvas.addEventListener("mouseleave", () => tooltip.classList.add("hidden"));

  function cssWidthMinus(width, tooltipWidth) {
    return Math.max(4, width - tooltipWidth - 8);
  }

  async function refreshUsage() {
    try {
      const usage = await api(`/api/usage?bucket=${state.bucket}`);
      state.usage = usage;
      state.chart.buckets = usage.buckets.map((bucket) => ({
        label: bucket.label,
        inputTokens: Number(bucket.inputTokens ?? 0),
        outputTokens: Number(bucket.outputTokens ?? 0),
        reasoningTokens: Number(bucket.reasoningTokens ?? 0),
        cacheReadTokens: Number(bucket.cacheReadTokens ?? 0),
        costUsd: Number(bucket.costUsd ?? 0),
      }));
      const periodCost = state.chart.buckets.reduce((sum, bucket) => sum + bucket.costUsd, 0);
      const periodInput = state.chart.buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0);
      const periodOutput = state.chart.buckets.reduce((sum, bucket) => sum + bucket.outputTokens, 0);
      $("periodTotal").textContent = state.metric === "cost" ? `period: ${fmtUsd(periodCost)}` : `period: ${fmtTokens(periodInput + periodOutput)} tokens`;
      $("totalToday").textContent = fmtMetric(usage.totals.today.costUsd, usage.totals.today.tokens);
      $("totalWeek").textContent = fmtMetric(usage.totals.week.costUsd, usage.totals.week.tokens);
      $("totalMonth").textContent = fmtMetric(usage.totals.month.costUsd, usage.totals.month.tokens);
      $("totalAll").textContent = fmtMetric(usage.totals.all.costUsd, usage.totals.all.tokens);
      drawChart();
    } catch (error) {
      setHint(`Usage refresh failed: ${error.message}`);
    }
  }

  $("metricSeg").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    for (const sibling of $("metricSeg").children) sibling.classList.toggle("active", sibling === button);
    state.metric = button.dataset.metric;
    for (const element of [$("totalToday"), $("totalWeek"), $("totalMonth"), $("totalAll")]) element.dataset.mode = state.metric;
    refreshUsage();
  });

  $("bucketSeg").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    for (const sibling of $("bucketSeg").children) sibling.classList.toggle("active", sibling === button);
    state.bucket = button.dataset.bucket;
    refreshUsage();
  });

  window.addEventListener("resize", () => drawChart());

  // ---------------------------------------------------------------- setup page

  let setupState = null;
  let editorSlotName = null;
  let pairPollTimer = null;

  function showPage(name) {
    const isSetup = name === "setup";
    const isSettings = name === "settings";
    $("dashboardPage").classList.toggle("hidden", isSetup || isSettings);
    $("setupPage").classList.toggle("hidden", !isSetup);
    $("settingsPage").classList.toggle("hidden", !isSettings);
    $("tabDashboard").classList.toggle("active", !isSetup && !isSettings);
    $("tabSetup").classList.toggle("active", isSetup);
    $("tabSettings").classList.toggle("active", isSettings);
    if (isSetup) refreshSetup();
    else if (isSettings) refreshSettings();
    else { refreshStatus(); drawChart(); }
  }
  $("tabDashboard").addEventListener("click", () => showPage("dashboard"));
  $("tabSetup").addEventListener("click", () => showPage("setup"));
  $("tabSettings").addEventListener("click", () => showPage("settings"));

  function setLine(id, text, kind) {
    const element = $(id);
    if (!element) return;
    element.textContent = text ?? "";
    element.className = "status-line" + (kind ? ` ${kind}` : "");
  }

  function checkChip(label, ok, detail) {
    const title = String(detail ?? "").replace(/"/g, "&quot;");
    return `<span class="check-chip ${ok ? "ok" : "bad"}" title="${title}">${label}</span>`;
  }

  async function refreshSetup() {
    try {
      const data = await api("/api/setup/status");
      const s = data.status;
      setupState = s;
      $("dataRootPath").textContent = s.dataRoot;
      $("setupChecks").innerHTML = [
        checkChip("Node.js", s.prerequisites.node.ok, s.prerequisites.node.detail),
        checkChip("Python venv", s.prerequisites.python.ok, s.prerequisites.python.detail),
        checkChip("Chrome", s.prerequisites.chrome.ok, s.prerequisites.chrome.detail),
        checkChip("DPAPI", data.dpapi),
        checkChip("Bot token", s.telegram.tokenStored),
        checkChip("Paired", s.owner.paired, s.owner.userId ?? "not paired yet"),
        checkChip("Model slots", s.slots.length > 0, s.slots.map((slot) => slot.name).join(", ")),
      ].join("");
      $("prereqList").innerHTML = [
        `<li><span class="mark ${s.prerequisites.node.ok ? "ok" : ""}">${s.prerequisites.node.ok ? "OK" : "MISSING"}</span><span><b>Node.js 24+</b> — ${s.prerequisites.node.detail}</span></li>`,
        `<li><span class="mark ${s.prerequisites.python.ok ? "ok" : ""}">${s.prerequisites.python.ok ? "OK" : "MISSING"}</span><span><b>Python virtual environment</b> — ${s.prerequisites.python.detail}</span></li>`,
        `<li><span class="mark ${s.prerequisites.chrome.ok ? "ok" : ""}">${s.prerequisites.chrome.ok ? "OK" : "MISSING"}</span><span><b>Google Chrome</b> — ${s.prerequisites.chrome.detail}</span></li>`,
      ].join("");
      if (s.owner.paired) setLine("pairDone", `Paired as ${s.owner.userId}. You can message your bot.`, "ok");
      renderSlots(s);
      renderPresets(s);

      if (s.pairing.state === "candidate" && s.pairing.candidate) {
        $("pairCandidate").textContent = `${s.pairing.candidate.displayName || "your account"} (id ${s.pairing.candidate.userId})`;
        $("pairAcceptBtn").disabled = false;
        setLine("pairStatus", `Found ${s.pairing.candidate.displayName || s.pairing.candidate.userId}. Press Accept as owner.`, "ok");
      } else if (s.pairing.state === "waiting") {
        $("pairAcceptBtn").disabled = true;
      } else if (s.pairing.state === "accepted") {
        $("pairAcceptBtn").disabled = true;
      }
    } catch (error) {
      $("setupChecks").innerHTML = `<span class="check-chip bad">setup status failed: ${error.message}</span>`;
    }
  }

  $("tokenSaveBtn").addEventListener("click", async () => {
    setLine("tokenResult", "Verifying with Telegram…", "busy");
    try {
      const result = await api("/api/setup/telegram", { method: "POST", body: { token: $("tokenInput").value } });
      if (result.ok) {
        $("tokenInput").value = "";
        setLine("tokenResult", `${result.message}${result.botUsername ? ` Bot: @${result.botUsername}` : ""}`, "ok");
        $("webhookRow").classList.toggle("hidden", !result.webhookUrl);
      } else {
        setLine("tokenResult", result.message, "err");
        $("webhookRow").classList.add("hidden");
      }
      refreshSetup();
    } catch (error) {
      setLine("tokenResult", error.message, "err");
    }
  });
  $("webhookDeleteBtn").addEventListener("click", async () => {
    const result = await api("/api/setup/telegram/webhook-delete", { method: "POST" });
    setLine("tokenResult", result.message, result.ok ? "ok" : "err");
    if (result.ok) $("webhookRow").classList.add("hidden");
    refreshSetup();
  });

  function stopPairPolling() {
    if (pairPollTimer) { clearInterval(pairPollTimer); pairPollTimer = null; }
  }
  $("pairStartBtn").addEventListener("click", async () => {
    setLine("pairStatus", "Creating a pairing code…", "busy");
    const result = await api("/api/setup/pair/start", { method: "POST" });
    if (!result.ok) { setLine("pairStatus", result.message, "err"); return; }
    $("pairBox").classList.remove("hidden");
    $("pairCode").textContent = `/start ${result.code}`;
    $("pairLink").href = result.deepLink ?? "#";
    $("pairBotUsername").textContent = `@${result.botUsername}`;
    $("pairCandidate").textContent = "your account";
    $("pairAcceptBtn").disabled = true;
    setLine("pairStatus", "Waiting for your /start message…", "busy");
    stopPairPolling();
    pairPollTimer = setInterval(async () => {
      try {
        const status = await api("/api/setup/pair/status");
        if (status.pairing.state === "candidate" && status.pairing.candidate) {
          $("pairCandidate").textContent = `${status.pairing.candidate.displayName || "your account"} (id ${status.pairing.candidate.userId})`;
          $("pairAcceptBtn").disabled = false;
          setLine("pairStatus", "Found your account. Press Accept as owner.", "ok");
          stopPairPolling();
        }
      } catch { /* keep polling */ }
    }, 2000);
  });
  $("pairAcceptBtn").addEventListener("click", async () => {
    const result = await api("/api/setup/pair/accept", { method: "POST" });
    if (result.ok) {
      stopPairPolling();
      $("pairBox").classList.add("hidden");
      setLine("pairDone", result.message, "ok");
      refreshSetup();
    } else {
      setLine("pairStatus", result.message, "err");
    }
  });
  $("pairCancelBtn").addEventListener("click", async () => {
    await api("/api/setup/pair/cancel", { method: "POST" });
    stopPairPolling();
    $("pairBox").classList.add("hidden");
    setLine("pairStatus", "Pairing cancelled.");
  });

  function slotStateText(slot) {
    if (!slot.keyRequired) return "no key needed";
    if (slot.keyStored) return slot.keySource === "existing-pi-credentials" ? "key · existing Pi credentials" : "key · stored";
    return "key · not set";
  }

  function renderSlots(s) {
    const list = $("slotList");
    list.innerHTML = s.slots
      .map((slot) => {
        const caps = [
          slot.vision ? "vision" : "text only",
          slot.cost && (slot.cost.input || slot.cost.output) ? `$${slot.cost.input}/$${slot.cost.output} per M` : null,
          slot.thinkingLevels.length ? `thinking ${slot.thinkingLevels.join("/")}` : null,
          slot.endpoint ? "local endpoint" : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return `
          <div class="slot-card ${slot.active ? "active" : ""}" data-slot="${slot.name}">
            <div class="slot-card-head"><b>${slot.label}</b><span class="slot-state">${slot.active ? "active" : slotStateText(slot)}</span></div>
            <div class="slot-model">${slot.provider} / ${slot.modelId}</div>
            <div class="slot-meta">${caps}</div>
            <div class="slot-actions">
              <button class="btn" data-use-slot="${slot.name}">Use</button>
              <button class="btn" data-edit-slot="${slot.name}">Configure</button>
            </div>
          </div>`;
      })
      .join("");
    for (const button of list.querySelectorAll("[data-use-slot]")) {
      button.addEventListener("click", async () => {
        const result = await api("/api/setup/slot/select", { method: "POST", body: { name: button.dataset.useSlot } });
        setLine("modelResult", result.message, result.ok ? "ok" : "err");
        refreshSetup();
        refreshStatus();
      });
    }
    for (const button of list.querySelectorAll("[data-edit-slot]")) {
      button.addEventListener("click", () => openSlotEditor(button.dataset.editSlot));
    }
  }

  function renderPresets(s) {
    const list = $("presetList");
    const available = s.presets.filter((preset) => !preset.configured);
    list.innerHTML = available.length
      ? available.map((preset) => `<button class="btn" data-preset="${preset.slot}" title="${preset.description.replace(/"/g, "&quot;")}">+ ${preset.label}</button>`).join("")
      : `<span class="muted">All known providers are configured.</span>`;
    for (const button of list.querySelectorAll("[data-preset]")) {
      button.addEventListener("click", async () => {
        const preset = s.presets.find((entry) => entry.slot === button.dataset.preset);
        if (!preset) return;
        setLine("modelResult", `Adding ${preset.label}…`, "busy");
        const result = await api("/api/setup/slot", {
          method: "POST",
          body: {
            name: preset.slot,
            provider: preset.provider,
            modelId: preset.modelId,
            label: preset.label,
            endpoint: preset.endpoint ?? null,
            routing: preset.routing ?? null,
            activate: false,
          },
        });
        setLine("modelResult", result.message, result.ok ? "ok" : "err");
        await refreshSetup();
        if (result.ok) openSlotEditor(preset.slot);
      });
    }
  }

  function renderModelOptions(ids) {
    const list = $("editorModelList");
    if (!list) return;
    list.classList.remove("hidden");
    list.innerHTML = ids.slice(0, 400).map((id) => `<option value="${id}">${id}</option>`).join("");
    list.onchange = () => {
      if (list.value) $("editorModelId").value = list.value;
    };
  }

  function openSlotEditor(name) {
    const s = setupState;
    const slot = s?.slots.find((entry) => entry.name === name);
    if (!slot) return;
    editorSlotName = name;
    const editor = $("slotEditor");
    editor.classList.remove("hidden");
    const levels = slot.thinkingLevels.length ? slot.thinkingLevels : ["off"];
    editor.innerHTML = `
      <div class="editor-head"><b>Configure ${slot.label}</b><span class="muted">${slot.provider}${slot.endpointInfo ? ` · ${slot.endpointInfo.baseUrl}` : ""}</span></div>
      <div class="editor-grid">
        <div class="field-row">
          <label class="field-label">Model id</label>
          <input id="editorModelId" class="input" value="${slot.modelId}" />
          <button class="btn" id="editorBrowse">Browse models</button>
        </div>
        <select id="editorModelList" class="input select editor-list hidden" size="8"></select>
        ${slot.endpointInfo ? `
        <div class="field-row">
          <label class="field-label">Endpoint URL</label>
          <input id="editorBaseUrl" class="input" value="${slot.endpointInfo.baseUrl}" />
          <button class="btn" id="editorDiscover">Discover local models</button>
        </div>` : ""}
        <div class="field-row">
          <label class="field-label">Thinking</label>
          <select id="editorThinking" class="input select">${levels.map((level) => `<option value="${level}" ${level === slot.thinking ? "selected" : ""}>${level}</option>`).join("")}</select>
        </div>
        ${slot.keyRequired ? `
        <div class="field-row">
          <label class="field-label">API key</label>
          <input id="editorKey" class="input" type="password" placeholder="${slot.keyStored ? "stored — paste a new key to replace" : "paste key"}" autocomplete="off" />
          <button class="btn" id="editorSaveKey">Save key</button>
          <button class="btn small" id="editorRemoveKey">Remove</button>
        </div>` : ""}
        <div class="field-row">
          <button class="btn primary" id="editorSave">Save</button>
          <button class="btn" id="editorActivate">Use as active</button>
          <button class="btn small" id="editorDelete">Remove slot</button>
        </div>
        <div class="status-line" id="editorResult"></div>
      </div>`;

    $("editorBrowse").addEventListener("click", async () => {
      setLine("editorResult", "Loading catalog…", "busy");
      const result = await api(`/api/setup/models?provider=${encodeURIComponent(slot.provider)}`);
      if (result.endpointModels?.length) {
        renderModelOptions(result.endpointModels.map((model) => model.id));
        setLine("editorResult", result.message, "ok");
        return;
      }
      if (!result.ok) {
        setLine("editorResult", result.message, "err");
        return;
      }
      renderModelOptions(result.models.map((model) => model.id));
      setLine("editorResult", result.message, "ok");
    });
    if (slot.endpointInfo) {
      $("editorDiscover")?.addEventListener("click", async () => {
        const baseUrl = $("editorBaseUrl").value.trim();
        setLine("editorResult", "Contacting the local endpoint…", "busy");
        const result = await api(`/api/setup/models?provider=${encodeURIComponent(slot.provider)}&baseUrl=${encodeURIComponent(baseUrl)}`);
        if (!result.ok) {
          setLine("editorResult", result.message, "err");
          return;
        }
        renderModelOptions((result.endpointModels ?? []).map((model) => model.id));
        setLine("editorResult", result.message, "ok");
      });
    }
    $("editorSaveKey")?.addEventListener("click", async () => {
      setLine("editorResult", `Validating with ${slot.provider}…`, "busy");
      const result = await api("/api/setup/api-key", { method: "POST", body: { provider: slot.provider, key: $("editorKey").value } });
      setLine("editorResult", `${result.message}${result.detail ? ` ${result.detail}` : ""}`, result.ok ? "ok" : "err");
      if (result.ok) {
        $("editorKey").value = "";
        refreshSetup();
      }
    });
    $("editorRemoveKey")?.addEventListener("click", async () => {
      const result = await api("/api/setup/api-key/delete", { method: "POST", body: { provider: slot.provider } });
      setLine("editorResult", result.message, result.ok ? "ok" : "err");
      refreshSetup();
    });
    $("editorSave").addEventListener("click", async () => {
      setLine("editorResult", "Saving…", "busy");
      const modelId = $("editorModelId").value.trim();
      const body = {
        name,
        provider: slot.provider,
        modelId,
        label: slot.label,
        thinking: $("editorThinking")?.value ?? null,
        activate: slot.active,
        endpoint: null,
      };
      if (slot.endpointInfo) {
        const declared = slot.endpointInfo.models ?? [];
        const existing = declared.find((model) => model.id === modelId);
        body.endpoint = {
          baseUrl: $("editorBaseUrl").value.trim(),
          api: "openai-completions",
          apiKey: slot.endpointInfo.apiKey ?? "lm-studio",
          models: existing ? declared : [...declared, { id: modelId, name: modelId, input: ["text", "image"], contextWindow: 32768, maxTokens: 8192, reasoning: false }],
        };
      }
      const result = await api("/api/setup/slot", { method: "POST", body });
      setLine("editorResult", result.message, result.ok ? "ok" : "err");
      refreshSetup();
      refreshStatus();
    });
    $("editorActivate").addEventListener("click", async () => {
      const result = await api("/api/setup/slot/select", { method: "POST", body: { name } });
      setLine("editorResult", result.message, result.ok ? "ok" : "err");
      refreshSetup();
      refreshStatus();
    });
    $("editorDelete").addEventListener("click", async () => {
      if (!confirm(`Remove slot "${name}"?`)) return;
      const result = await api("/api/setup/slot/delete", { method: "POST", body: { name } });
      setLine("modelResult", result.message, result.ok ? "ok" : "err");
      if (result.ok) {
        $("slotEditor").classList.add("hidden");
        editorSlotName = null;
      }
      refreshSetup();
    });
  }
  $("browserSigninBtn").addEventListener("click", async () => {
    setLine("browserResult", "Opening Chrome…", "busy");
    const result = await api("/api/setup/browser-signin", { method: "POST" });
    setLine("browserResult", result.message, result.ok ? "ok" : "err");
  });
  $("setupStartBtn").addEventListener("click", async () => {
    await runAction("start");
    showPage("dashboard");
  });
  $("setupDashboardBtn").addEventListener("click", () => showPage("dashboard"));

  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy]");
    if (!button) return;
    try {
      await navigator.clipboard.writeText($(button.dataset.copy).textContent);
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = "Copy"; }, 1200);
    } catch { /* clipboard may be blocked */ }
  });

  // ---------------------------------------------------------------- settings page

  let settingsState = null;

  function aboutRow(label, value) {
    return `<div class="about-row"><span>${label}</span><code>${value}</code></div>`;
  }

  async function refreshSettings() {
    try {
      const data = await api("/api/settings");
      settingsState = data;
      $("startupToggle").checked = data.startup.registered && data.startup.enabled;
      $("startupStatus").textContent = data.startup.registered
        ? `Registered · ${data.startup.state}${data.startup.trigger ? ` · ${data.startup.trigger}` : ""}`
        : "Not registered — the assistant only starts when you launch it.";
      $("pauseInputToggle").checked = data.settings.pauseOnObservedHumanInput;
      $("hotkeyInput").value = data.settings.localStopHotkey;
      $("maxRunInput").value = Math.round(data.settings.maxRunSeconds / 60);
      $("maxQueuedInput").value = data.settings.maxQueued;
      $("retentionInput").value = data.settings.retentionDays;
      $("aboutPaths").innerHTML = [
        aboutRow("Data root", data.paths.dataRoot),
        aboutRow("Work folder", data.paths.workRoot),
        aboutRow("Config file", data.paths.configPath),
        aboutRow("Logs", data.paths.logsDir),
        aboutRow("Active model", `${data.info.provider}/${data.info.modelId} · ${data.info.thinking}`),
        aboutRow("Time zone", data.info.timeZone),
      ].join("");
      $("aboutVersions").innerHTML = [
        aboutRow("Alfred", `v${data.versions.app}`),
        aboutRow("Node.js", data.versions.node),
        aboutRow("Pi SDK", data.versions.piSdk),
        aboutRow("windows-mcp", data.versions.windowsMcp),
        aboutRow("@playwright/mcp", data.versions.playwrightMcp),
      ].join("");
    } catch (error) {
      setLine("behaviourResult", `Could not load settings: ${error.message}`, "err");
    }
  }

  $("startupToggle").addEventListener("change", async (event) => {
    const enabled = event.target.checked;
    event.target.disabled = true;
    setLine("startupResult", enabled ? "Registering the startup task…" : "Removing the startup task…", "busy");
    try {
      const result = await api("/api/settings/startup", { method: "POST", body: { enabled } });
      setLine("startupResult", result.message, result.ok ? "ok" : "err");
      if (result.startup) {
        event.target.checked = result.startup.registered && result.startup.enabled;
        $("startupStatus").textContent = result.startup.registered
          ? `Registered · ${result.startup.state}${result.startup.trigger ? ` · ${result.startup.trigger}` : ""}`
          : "Not registered — the assistant only starts when you launch it.";
      }
    } catch (error) {
      setLine("startupResult", `Failed: ${error.message}`, "err");
      event.target.checked = !enabled;
    } finally {
      event.target.disabled = false;
    }
    refreshStatus();
  });

  $("saveBehaviourBtn").addEventListener("click", async () => {
    setLine("behaviourResult", "Saving…", "busy");
    const result = await api("/api/settings", {
      method: "POST",
      body: {
        pauseOnObservedHumanInput: $("pauseInputToggle").checked,
        localStopHotkey: $("hotkeyInput").value.trim(),
        maxRunSeconds: Math.max(1, Number($("maxRunInput").value) || 30) * 60,
        maxQueued: Math.max(1, Number($("maxQueuedInput").value) || 5),
      },
    });
    setLine("behaviourResult", result.message, result.ok ? "ok" : "err");
  });

  $("saveDataBtn").addEventListener("click", async () => {
    setLine("dataResult", "Saving…", "busy");
    const result = await api("/api/settings", { method: "POST", body: { retentionDays: Math.max(1, Number($("retentionInput").value) || 7) } });
    setLine("dataResult", result.message, result.ok ? "ok" : "err");
  });

  for (const button of document.querySelectorAll("[data-open]")) {
    button.addEventListener("click", async () => {
      const result = await api("/api/settings/open", { method: "POST", body: { target: button.dataset.open } });
      setLine("dataResult", result.message, result.ok ? "ok" : "err");
    });
  }

  // ---------------------------------------------------------------- boot

  applyFilters();
  refreshStatus();
  refreshUsage();
  connectEvents();
  if (location.hash === "#settings") showPage("settings");
  else if (location.hash === "#setup" || location.hash.startsWith("#step-")) showPage("setup");
  if (location.hash.startsWith("#step-")) {
    setTimeout(() => { document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" }); }, 300);
  }
  setInterval(refreshStatus, 3000);
  setInterval(refreshUsage, 30000);
  setInterval(() => { if (!$("setupPage").classList.contains("hidden")) refreshSetup(); }, 5000);
})();
