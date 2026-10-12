import assert from "node:assert/strict";
import test from "node:test";
import { queueStateTransition, type PersistentQueueState } from "../src/extension/task_flow";

test("persisted queue state machine permits only declared lifecycle transitions", () => {
  const allowed: Array<[PersistentQueueState, PersistentQueueState]> = [
    ["queued", "running"], ["running", "queued"], ["running", "completed"],
    ["running", "failed"], ["running", "skipped"]
  ];
  for (const [current, next] of allowed) assert.equal(queueStateTransition(current, next), next);
  for (const state of ["queued", "running", "completed", "failed", "skipped"] as const) assert.equal(queueStateTransition(state, state), state);
});

test("persisted queue state machine makes terminal states absorbing", () => {
  for (const terminal of ["completed", "failed", "skipped"] as const) {
    for (const next of ["queued", "running", "completed", "failed", "skipped"] as const) {
      if (next === terminal) continue;
      assert.throws(() => queueStateTransition(terminal, next), new RegExp(`${terminal} -> ${next}`));
    }
  }
  assert.throws(() => queueStateTransition("queued", "completed"), /queued -> completed/);
  assert.throws(() => queueStateTransition("queued", "failed"), /queued -> failed/);
});
