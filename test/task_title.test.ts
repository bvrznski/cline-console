import assert from "node:assert/strict";
import test from "node:test";
import { taskTitle } from "../src/common/task_title";

test("task title prefers a phase heading over separator boilerplate", () => {
  assert.equal(taskTitle("# =============================================================================\n# GORDON COGNITIVE ARCHITECTURE\n# PHASE 6.5 — PART 1\n# KNOWLEDGE RELATIONS"), "# PHASE 6.5 — PART 1");
  assert.equal(taskTitle("# =============================================================================\n\n# GORDON COGNITIVE ARCHITECTURE\n\n# PHASE 7.42 — PART 1"), "# PHASE 7.42 — PART 1");
  assert.equal(taskTitle("GORDON PHASE 7.116\n# CREATIVITY / GENERATION\nLater text\nPhase 7.116 is complete only when:"), "GORDON PHASE 7.116");
});

test("task title falls back to the first meaningful line", () => {
  assert.equal(taskTitle("\n---\nBuild the feature\nDetails"), "Build the feature");
  assert.equal(taskTitle("===\n---"), undefined);
});
