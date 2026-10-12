import assert from "node:assert/strict";
import test from "node:test";
import { bold, color, colorizeCommandOutput, stateColor } from "../src/common/terminal";
import { formatQueue } from "../src/client/commands/queue";

test("terminal styles emit ANSI only when explicitly enabled", () => {
  assert.equal(color("running", "yellow", false), "running");
  assert.equal(color("running", "yellow", true), "\u001b[33mrunning\u001b[0m");
  assert.equal(color("interrupted", "magenta", true), "\u001b[35minterrupted\u001b[0m");
  assert.equal(bold("Title", true), "\u001b[1mTitle\u001b[0m");
  assert.equal(stateColor("completed"), "green");
  assert.equal(stateColor("failed"), "red");
});

test("command output colorizer styles human output without contaminating plain output", () => {
  const plain = "Workspace: /repo\nTask: running\nTask started successfully.\n";
  assert.equal(colorizeCommandOutput(plain, false), plain);
  const colored = colorizeCommandOutput(plain, true);
  assert.match(colored, /\u001b\[1mWorkspace:\u001b\[0m/);
  assert.match(colored, /\u001b\[36m\/repo\u001b\[0m/);
  assert.match(colored, /\u001b\[33mrunning\u001b\[0m/);
  assert.match(colored, /\u001b\[32mTask started successfully\./);
  assert.equal(colorizeCommandOutput('{"state":"running"}', false), '{"state":"running"}');
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
