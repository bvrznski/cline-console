import assert from "node:assert/strict";
import test from "node:test";
import { formatTasks } from "../src/client/commands/tasks";

test("task listing reports reconciled task state and source path", () => {
  const output = formatTasks([{ workspace: "/repo", status: { connected: true, version: "4.1.7", task: "active", state: "submitted", title: "# Build feature", sourcePath: "/tasks/build.md" } }]);
  assert.match(output, /\/repo\s+active\s+submitted\s+4\.1\.7\s+# Build feature/);
  assert.match(output, /\/tasks\/build\.md/);
  assert.match(output, /reconciled/);
});

test("task listing retains per-workspace connection errors", () => {
  assert.match(formatTasks([{ workspace: "/repo", error: "socket closed" }]), /error\s+unavailable\s+unknown\s+-\s+socket closed/);
});
