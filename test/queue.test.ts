import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatQueue, formatQueues } from "../src/client/commands/queue";
import { discoverPersistedQueueStatuses, readQueueStatusFile, remainingTaskDispatchDelay, TaskQueue } from "../src/extension/task_queue";
import type { ClineAdapter } from "../src/integrations/cline/types";
import type { Logger } from "../src/common/logging";
import { deleteLegacyQueuedTaskHistory, deleteLegacyWorkspaceTaskHistory } from "../src/integrations/cline/task_history";

const logger: Logger = { error() {}, info() {}, debug() {} };

function adapterWithStatus(task: "active" | "none", state: "running" | "unknown"): ClineAdapter {
  return {
    newTask: async () => ({ taskStarted: true }), sendMessage: async () => {}, cancelTask: async () => {}, detect: async () => true,
    getVersion: async () => "test", getCapabilities: async () => ({ newTask: true, followup: true, cancel: true, taskStatus: true, taskId: true, directApi: true, commandApi: true, webviewBridge: false }),
    getStatus: async () => ({ connected: true, task, state })
  };
}

test("queue formatter displays active items without prompt bodies", () => {
  const output = formatQueue({
    workspace: "/repo", paused: false, queueLength: 2, running: 1, queued: 1, completed: 3, failed: 1,
    items: [
      { position: 1, id: "one", kind: "task", state: "running", title: "# Phase 1", sourcePath: "/tasks/1.md", queuedAt: "2026-08-10T00:00:00Z" },
      { position: 2, id: "two", kind: "message", state: "queued", title: "Run tests", sourcePath: "<inline-or-stdin>", queuedAt: "2026-08-10T00:01:00Z" }
    ]
  });
  assert.match(output, /Queue length: 2 \(1 running, 1 queued\)/);
  assert.match(output, /Pos\s+Type\s+State\s+Title\s+Source\n-+\s+-+\s+-+\s+-+\s+-+/);
  assert.match(output, /1\s+task\s+running\s+# Phase 1\s+\/tasks\/1\.md/);
  assert.match(output, /2\s+message\s+queued\s+Run tests/);
});

test("queued tasks wait 30 seconds after the previous task finishes", () => {
  const now = Date.parse("2026-08-10T12:00:20.000Z");
  assert.equal(remainingTaskDispatchDelay([{ kind: "task", state: "completed", finishedAt: "2026-08-10T12:00:00.000Z" }], now), 10_000);
  assert.equal(remainingTaskDispatchDelay([{ kind: "task", state: "failed", finishedAt: "2026-08-10T11:59:40.000Z" }], now), 0);
  assert.equal(remainingTaskDispatchDelay([{ kind: "message", state: "completed", finishedAt: "2026-08-10T12:00:19.000Z" }], now), 0);
  assert.equal(remainingTaskDispatchDelay([{ kind: "task", state: "skipped", finishedAt: "2026-08-10T12:00:19.000Z" }], now), 0);
});

test("queue formatter reports an empty queue", () => {
  assert.match(formatQueue({ workspace: "/repo", paused: true, queueLength: 0, running: 0, queued: 0, completed: 0, failed: 0, items: [] }), /Queue is empty/);
});

test("global queue formatter displays every registered workspace", () => {
  const output = formatQueues([
    { workspace: "/one", status: { workspace: "/one", paused: false, queueLength: 0, running: 0, queued: 0, completed: 1, failed: 0, items: [] } },
    { workspace: "/two", error: "socket closed" }
  ]);
  assert.match(output, /Workspace: \/one[\s\S]*Queue is empty/);
  assert.match(output, /Workspace: \/two[\s\S]*Queue unavailable: socket closed/);
});

test("persisted queue status exposes titles but not prompt bodies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-status-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", items: [
    { id: "one", sourcePath: "/tasks/one.md", prompt: "# Title\nsecret body", state: "queued", queuedAt: "now" },
    { id: "done", sourcePath: "/tasks/done.md", prompt: "Done\nbody", state: "completed", queuedAt: "before" }
  ] }));
  const status = await readQueueStatusFile(file, "/repo");
  assert.equal(status.queueLength, 1);
  assert.equal(status.paused, false);
  assert.equal(status.completed, 1);
  assert.equal(status.items[0].title, "# Title");
  assert.equal(JSON.stringify(status).includes("secret body"), false);
  await fs.rm(root, { recursive: true });
});

test("persisted queues are discoverable without a live workspace registration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-discovery-"));
  await fs.writeFile(path.join(root, "queue-0123456789abcdef.json"), JSON.stringify({ version: 1, workspace: "/offline/repo", items: [
    { id: "one", sourcePath: "/tasks/one.md", prompt: "Offline task\nprivate body", state: "queued", queuedAt: "now" }
  ] }));
  await fs.writeFile(path.join(root, "unrelated.json"), "{}");
  const statuses = await discoverPersistedQueueStatuses(root);
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].workspace, "/offline/repo");
  assert.equal(statuses[0].items[0].title, "Offline task");
  assert.equal(JSON.stringify(statuses).includes("private body"), false);
  await fs.rm(root, { recursive: true });
});

test("queue formatter marks a persisted workspace whose companion is offline", () => {
  const output = formatQueues([{ workspace: "/offline/repo", companionConnected: false, status: {
    workspace: "/offline/repo", paused: false, queueLength: 0, running: 0, queued: 0, completed: 1, failed: 0, items: []
  } }]);
  assert.match(output, /VS Code companion: offline/);
});

test("queue clear removes a stale running entry when tasks is not active", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-clear-stale-")), file = path.join(root, "queue.json"), workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace, items: [
    { id: "stale", sourcePath: "/tasks/stale.md", prompt: "Stale task", state: "running", queuedAt: "before", dispatchedAt: "2026-08-10T00:00:00Z" },
    { id: "waiting", sourcePath: "/tasks/waiting.md", prompt: "Waiting task", state: "queued", queuedAt: "now" }
  ] }));
  const queue = new TaskQueue(file, workspace, adapterWithStatus("none", "unknown"), logger);
  try {
    await queue.start();
    assert.deepEqual(await queue.clear(), { cleared: 2, clearedWaiting: 1, clearedStaleRunning: 1, queueLength: 0, runningPreserved: false, historyDeleted: 0 });
    assert.equal(queue.getStatus().queueLength, 0);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("queue clear enforces removal of a running entry when tasks is active", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-clear-active-")), file = path.join(root, "queue.json"), workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace, items: [
    { id: "active", sourcePath: "/tasks/active.md", prompt: "Active task", state: "running", queuedAt: "before", dispatchedAt: "2026-08-10T00:00:00Z" },
    { id: "waiting", sourcePath: "/tasks/waiting.md", prompt: "Waiting task", state: "queued", queuedAt: "now" }
  ] }));
  const queue = new TaskQueue(file, workspace, adapterWithStatus("active", "running"), logger);
  try {
    await queue.start();
    assert.deepEqual(await queue.clear(), { cleared: 2, clearedWaiting: 1, clearedStaleRunning: 1, queueLength: 0, runningPreserved: false, historyDeleted: 0 });
    assert.equal(queue.getStatus().running, 0);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("queue history clearance deletes only exact queued tasks in the selected workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-history-clear-"));
  await fs.mkdir(path.join(root, "state"), { recursive: true });
  for (const id of ["queued", "manual", "other"]) await fs.mkdir(path.join(root, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(root, "state", "taskHistory.json"), JSON.stringify([
    { id: "queued", cwdOnTaskInitialization: "/repo", task: "Queued prompt" },
    { id: "manual", cwdOnTaskInitialization: "/repo", task: "Manual prompt" },
    { id: "other", cwdOnTaskInitialization: "/other", task: "Queued prompt" }
  ]));
  const result = await deleteLegacyQueuedTaskHistory("/repo", ["Queued prompt"], [], root);
  assert.deepEqual(result, { deleted: 1, taskIds: ["queued"] });
  const retained = JSON.parse(await fs.readFile(path.join(root, "state", "taskHistory.json"), "utf8")) as Array<{ id: string }>;
  assert.deepEqual(retained.map(item => item.id), ["manual", "other"]);
  await assert.rejects(fs.stat(path.join(root, "tasks", "queued")));
  assert.equal((await fs.stat(path.join(root, "tasks", "manual"))).isDirectory(), true);
  await fs.rm(root, { recursive: true });
});

test("workspace history clearance deletes every task only in the selected workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-workspace-clear-"));
  await fs.mkdir(path.join(root, "state"), { recursive: true });
  for (const id of ["one", "two", "other"]) await fs.mkdir(path.join(root, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(root, "state", "taskHistory.json"), JSON.stringify([
    { id: "one", cwdOnTaskInitialization: "/repo", task: "One" },
    { id: "two", cwdOnTaskInitialization: "/repo", task: "Two" },
    { id: "other", cwdOnTaskInitialization: "/other", task: "Other" }
  ]));
  assert.deepEqual(await deleteLegacyWorkspaceTaskHistory("/repo", root), { deleted: 2, taskIds: ["one", "two"] });
  const retained = JSON.parse(await fs.readFile(path.join(root, "state", "taskHistory.json"), "utf8")) as Array<{ id: string }>;
  assert.deepEqual(retained.map(item => item.id), ["other"]);
  assert.equal((await fs.stat(path.join(root, "tasks", "other"))).isDirectory(), true);
  await fs.rm(root, { recursive: true });
});

test("persisted pause prevents dispatch until queue resume", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-pause-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "one", kind: "task", sourcePath: "/tasks/one.md", prompt: "Task one", state: "queued", queuedAt: "now" }
  ] }));
  const dispatched: string[] = [];
  const adapter = {
    newTask: async (prompt: string) => { dispatched.push(prompt); return { taskStarted: true }; },
    sendMessage: async () => {}, cancelTask: async () => {}, detect: async () => true,
    getVersion: async () => "test", getCapabilities: async () => ({ newTask: true, followup: true, cancel: true, taskStatus: true, taskId: true, directApi: true, commandApi: true, webviewBridge: false }),
    getStatus: async () => ({ connected: true, task: "none" as const, state: "unknown" as const })
  } satisfies ClineAdapter;
  const queue = new TaskQueue(file, "/repo", adapter, logger);
  try {
    await queue.start();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(dispatched, []);
    assert.equal(queue.getStatus().paused, true);
    await queue.resume();
    const deadline = Date.now() + 3_000;
    while (!dispatched.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(dispatched, ["Task one"]);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("queue pop removes waiting items by exact title or source path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-pop-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "one", kind: "task", sourcePath: "/tasks/one.md", prompt: "First task\nprivate", state: "queued", queuedAt: "now" },
    { id: "two", kind: "task", sourcePath: "/tasks/two.md", prompt: "Second task\nprivate", state: "queued", queuedAt: "now" }
  ] }));
  const queue = new TaskQueue(file, "/repo", {} as ClineAdapter, logger);
  try {
    await queue.start();
    const byTitle = await queue.pop("First task", undefined, "title");
    assert.equal(byTitle.id, "one");
    assert.equal(byTitle.queueLength, 1);
    const byPath = await queue.pop("two.md", "/tasks/two.md", "file");
    assert.equal(byPath.id, "two");
    assert.equal(byPath.queueLength, 0);
    await assert.rejects(queue.pop("missing"), /No waiting queue item matches/);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("queue pop removes a waiting item by queue ID", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-pop-id-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "queue-id", sourcePath: "/tasks/one.md", prompt: "Task", state: "queued", queuedAt: "now" }
  ] }));
  const queue = new TaskQueue(file, "/repo", {} as ClineAdapter, logger);
  try {
    await queue.start();
    assert.equal((await queue.pop("queue-id", undefined, "id")).id, "queue-id");
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("queue pop rejects ambiguous displayed titles", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-pop-ambiguous-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "one", sourcePath: "/tasks/one.md", prompt: "Same title\none", state: "queued", queuedAt: "now" },
    { id: "two", sourcePath: "/tasks/two.md", prompt: "Same title\ntwo", state: "queued", queuedAt: "now" }
  ] }));
  const queue = new TaskQueue(file, "/repo", {} as ClineAdapter, logger);
  try {
    await queue.start();
    await assert.rejects(queue.pop("Same title"), /Multiple waiting queue items/);
    assert.equal(queue.getStatus().queued, 2);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("skipped incomplete task ID is persisted for the next dispatch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-skip-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [] }));
  const queue = new TaskQueue(file, "/repo", {} as ClineAdapter, logger);
  try {
    await queue.start();
    assert.deepEqual(await queue.skipWaitingTask("waiting-id"), { skipped: true, sessionId: "waiting-id" });
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { ignoredWaitingTaskIds?: string[] };
    assert.deepEqual(persisted.ignoredWaitingTaskIds, ["waiting-id"]);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});
