import { strict as assert } from "node:assert";
import { test } from "node:test";
import { assertTransition, canTransition, isTerminal, TERMINAL_STATES } from "../../src/jobs/state-machine.js";

test("valid transitions are accepted", () => {
  assert.equal(canTransition("queued", "starting"), true);
  assert.equal(canTransition("running", "paused"), true);
  assert.equal(canTransition("paused", "running"), true);
  assert.equal(canTransition("paused", "waiting_for_owner"), true);
  assert.equal(canTransition("waiting_for_unlock", "waiting_for_owner"), true);
  for (const state of ["paused", "waiting_for_owner", "waiting_for_unlock"] as const) assert.equal(canTransition(state, "interrupted"), true);
  assert.equal(canTransition("cancelling", "cancelled"), true);
  assert.equal(canTransition("running", "succeeded"), true);
});

test("invalid transitions are rejected", () => {
  assert.equal(canTransition("succeeded", "running"), false);
  assert.equal(canTransition("queued", "running"), false);
  assert.throws(() => assertTransition("succeeded", "running"), /Invalid job state transition/);
});

test("terminal states have no outgoing transitions", () => {
  for (const state of TERMINAL_STATES) {
    assert.equal(isTerminal(state), true);
    for (const target of ["queued", "running", "paused"] as const) {
      assert.equal(canTransition(state, target), false);
    }
  }
});
