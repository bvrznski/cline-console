import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatQueue } from "../src/client/commands/queue";
import { readQueueStatusFile } from "../src/extension/task_queue";

test("queue formatter displays active items without prompt bodies", () => {
  const output = formatQueue({
    workspace: "/repo", queueLength: 2, running: 1, queued: 1, completed: 3, failed: 1,
    items: [
      { position: 1, id: "one", kind: "task", state: "running", title: "# Phase 1", sourcePath: "/tasks/1.md", queuedAt: "2026-08-10T00:00:00Z" },
      { position: 2, id: "two", kind: "message", state: "queued", title: "Run tests", sourcePath: "<inline-or-stdin>", queuedAt: "2026-08-10T00:01:00Z" }
    ]
  });
  assert.match(output, /Queue length: 2 \(1 running, 1 queued\)/);
  assert.match(output, /1\s+task\s+running\s+# Phase 1\s+\/tasks\/1\.md/);
  assert.match(output, /2\s+message\s+queued\s+Run tests/);
});

test("queue formatter reports an empty queue", () => {
  assert.match(formatQueue({ workspace: "/repo", queueLength: 0, running: 0, queued: 0, completed: 0, failed: 0, items: [] }), /Queue is empty/);
});

test("persisted queue status exposes titles but not prompt bodies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-status-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", items: [
    { id: "one", sourcePath: "/tasks/one.md", prompt: "# Title\nsecret body", state: "queued", queuedAt: "now" },
    { id: "done", sourcePath: "/tasks/done.md", prompt: "Done\nbody", state: "completed", queuedAt: "before" }
  ] }));
  const status = await readQueueStatusFile(file, "/repo");
  assert.equal(status.queueLength, 1);
  assert.equal(status.completed, 1);
  assert.equal(status.items[0].title, "# Title");
  assert.equal(JSON.stringify(status).includes("secret body"), false);
  await fs.rm(root, { recursive: true });
});
