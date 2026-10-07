import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

class Element {
  checked = true;
  disabled = false;
  textContent = "";
  innerHTML = "";
  className = "";
  value = "";
  dataset = {};
  classes = new Set<string>();
  classList = { add: (name: string) => this.classes.add(name), remove: (name: string) => this.classes.delete(name),
    toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  listeners = new Map<string, (event: { target: Element }) => unknown>();
  addEventListener(name: string, handler: (event: { target: Element }) => unknown) { this.listeners.set(name, handler); }
  querySelectorAll() { return []; }
  setAttribute() {}
  getContext() { return {}; }
}

function dashboard(jobState = "paused", failSave = false) {
  const elements = new Map<string, Element>();
  const element = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const writes: Array<Record<string, unknown>> = [];
  let saved = true;
  const location = { origin: "http://127.0.0.1:8787", hash: "" };
  const status = { controllerRunning: true, controller: { activeJob: { id: "J-test", state: jobState, label: "research clients" } },
    model: { modelId: "fixture", thinking: "low" }, paired: true, queued: 0, time: new Date().toISOString() };
  const fetch = async (url: URL, options: { body?: string }) => {
    if (url.pathname === "/api/status") return { ok: true, json: async () => status };
    if (url.pathname === "/api/settings") {
      if (options.body) {
        const body = JSON.parse(options.body) as Record<string, unknown>;
        writes.push(body);
        if (failSave) throw new Error("network unavailable");
        saved = body.pauseOnObservedHumanInput as boolean;
      }
      return { ok: true, json: async () => ({ ok: true, message: "Saved immediately", settings: { pauseOnObservedHumanInput: saved } }) };
    }
    // Chart loading is outside this test; it must not call a real API.
    return new Promise(() => undefined);
  };
  runInNewContext(readFileSync(new URL("../../../dashboard/app.js", import.meta.url), "utf8"), {
    window: { PI_TOKEN: "fixture", location, matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    location, document: { getElementById: element, querySelectorAll: () => [], querySelector: () => null, documentElement: new Element(), addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} }, EventSource: class {}, URL, fetch, setTimeout: () => 0, setInterval: () => 0,
  });
  return { element, writes, saved: () => saved };
}

test("the real dashboard pause switch saves immediately without a Save click", async () => {
  const page = dashboard();
  const toggle = page.element("pauseInputToggle");
  toggle.checked = false;
  const pending = page.element("pauseInputToggle").listeners.get("change")!({ target: toggle });
  assert.equal(toggle.disabled, true, "prevent conflicting saves while the request is pending");
  await pending;
  assert.deepEqual(page.writes, [{ pauseOnObservedHumanInput: false }]);
  assert.equal(page.saved(), false);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  assert.match(page.element("behaviourResult").textContent, /Saved/);
});

test("a failed toggle save restores the actual saved state and explains the failure", async () => {
  const page = dashboard("paused", true);
  const toggle = page.element("pauseInputToggle");
  toggle.checked = false;
  await toggle.listeners.get("change")!({ target: toggle });
  assert.equal(page.saved(), true);
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  assert.match(page.element("behaviourResult").textContent, /Could not save.*network unavailable/);
});

test("dashboard labels waiting and paused states honestly and enables the matching controls", async () => {
  for (const [state, label, canResume] of [["paused", "Paused", true], ["waiting_for_owner", "Waiting for your answer", false], ["waiting_for_unlock", "Waiting for you to unlock", true]] as const) {
    const page = dashboard(state);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match(page.element("statusText").textContent, new RegExp(label));
    assert.doesNotMatch(page.element("statusText").textContent, /Working on/);
    assert.equal(page.element("resumeBtn").disabled, !canResume);
    assert.equal(page.element("statusDot").classes.has("attention"), true);
  }
});
