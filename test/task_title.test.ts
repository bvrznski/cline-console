import assert from "node:assert/strict";
import test from "node:test";
import { taskTitle } from "../src/common/task_title";

test("task title prefers a phase heading over separator boilerplate", () => {
  assert.equal(taskTitle("# =============================================================================\n# GORDON COGNITIVE ARCHITECTURE\n# PHASE 6.5 — PART 1\n# KNOWLEDGE RELATIONS"), "# PHASE 6.5 — PART 1");
});

test("task title falls back to the first meaningful line", () => {
  assert.equal(taskTitle("\n---\nBuild the feature\nDetails"), "Build the feature");
  assert.equal(taskTitle("===\n---"), undefined);
});
