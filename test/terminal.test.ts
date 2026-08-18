import assert from "node:assert/strict";
import test from "node:test";
import { bold, color, stateColor } from "../src/common/terminal";
import { formatQueue } from "../src/client/commands/queue";

test("terminal styles emit ANSI only when explicitly enabled", () => {
  assert.equal(color("running", "yellow", false), "running");
  assert.equal(color("running", "yellow", true), "\u001b[33mrunning\u001b[0m");
  assert.equal(bold("Title", true), "\u001b[1mTitle\u001b[0m");
  assert.equal(stateColor("completed"), "green");
  assert.equal(stateColor("failed"), "red");
});

test("colored queue output preserves content and adds ANSI styling", () => {
  const output = formatQueue({
    workspace: "/repo", paused: false, queueLength: 1, running: 1, queued: 0, completed: 0, failed: 0,
    items: [{ position: 1, id: "one", kind: "task", state: "running", title: "# Title", sourcePath: "/task.md", queuedAt: "now" }]
  }, true);
  assert.match(output, /\u001b\[33mrunning\s*\u001b\[0m/);
  assert.match(output, /# Title/);
  assert.match(output, /\/task\.md/);
});
