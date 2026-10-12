import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HistoryStore } from "../src/history/history_store";

test("SQLite history preserves full prompts, queue state, runs, and observed events", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-history-"));
  const file = path.join(root, "private", "history.sqlite3");
  const store = new HistoryStore(file);
  try {
    const prompt = "# Task title\n\nSensitive complete initial prompt";
    store.recordQueueSnapshot("/repo", [{ id: "task-1", kind: "task", sourcePath: "/tasks/one.md", prompt, state: "running", queuedAt: "2026-08-20T00:00:00Z", dispatchedAt: "2026-08-20T00:01:00Z", sessionId: "cline-1" }], "test");
    store.recordEvent("/repo", { type: "completion_result", source: "cline", observed: true, taskId: "task-1", queueItemId: "task-1", clineSessionId: "cline-1", payload: { status: "completed", body: "done" } });
    const listed = store.listTasks("/repo");
    assert.equal(listed.length, 1);
    assert.equal(listed[0].state, "running");
    assert.equal(listed[0].cline_session_id, "cline-1");
    const detail = store.getTask("task-1")!;
    assert.equal(detail.initial_prompt, prompt);
    assert.equal((detail.runs as unknown[]).length, 1);
    assert.equal((detail.events as unknown[]).length, 1);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

    store.recordQueueSnapshot("/repo", [], "clear");
    assert.equal(store.listTasks("/repo")[0].state, "cleared");
  } finally {
    store.close();
    await fs.rm(root, { recursive: true });
  }
});

test("SQLite history opens when an Electron host returns no diagnostic report", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-history-electron-"));
  const original = process.report.getReport;
  (process.report as unknown as { getReport: () => undefined }).getReport = () => undefined;
  let store: HistoryStore | undefined;
  try {
    store = new HistoryStore(path.join(root, "history.sqlite3"));
    store.recordEvent("/repo", { type: "yolo_daemon_restart_completed", source: "cline-console", observed: true });
    assert.equal(store.listTasks("/repo").length, 0);
  } finally {
    store?.close();
    process.report.getReport = original;
    await fs.rm(root, { recursive: true });
  }
});

test("incremental queue append preserves existing entries and records only new tasks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-history-append-"));
  const store = new HistoryStore(path.join(root, "history.sqlite3"));
  try {
    store.recordQueueSnapshot("/repo", [{ id: "old", kind: "task", sourcePath: "/old.md", prompt: "Old", state: "running", queuedAt: "2026-10-03T00:00:00Z" }], "initial");
    store.recordQueueAppend("/repo", [
      { id: "new-1", kind: "task", sourcePath: "/new-1.md", prompt: "New one", state: "queued", queuedAt: "2026-10-03T00:01:00Z" },
      { id: "new-2", kind: "task", sourcePath: "/new-2.md", prompt: "New two", state: "queued", queuedAt: "2026-10-03T00:01:00Z" }
    ], 1);
    const tasks = store.listTasks("/repo", 10);
    assert.equal(tasks.length, 3);
    assert.equal(tasks.find(item => item.id === "old")?.state, "running");
    assert.equal(tasks.find(item => item.id === "new-1")?.state, "queued");
    assert.equal(store.getTask("new-2")?.initial_prompt, "New two");
  } finally {
    store.close();
    await fs.rm(root, { recursive: true });
  }
});

test("incremental queue removal clears one entry and preserves the remaining queue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-history-remove-"));
  const store = new HistoryStore(path.join(root, "history.sqlite3"));
  try {
    store.recordQueueSnapshot("/repo", [
      { id: "running", kind: "task", sourcePath: "/running.md", prompt: "Running", state: "running", queuedAt: "2026-10-03T00:00:00Z" },
      { id: "remove", kind: "task", sourcePath: "/remove.md", prompt: "Remove", state: "queued", queuedAt: "2026-10-03T00:01:00Z" },
      { id: "keep", kind: "task", sourcePath: "/keep.md", prompt: "Keep", state: "queued", queuedAt: "2026-10-03T00:02:00Z" }
    ], "initial");
    store.recordQueueRemove("/repo", "remove", 2);
    const tasks = store.listTasks("/repo", 10);
    assert.equal(tasks.find(item => item.id === "running")?.state, "running");
    assert.equal(tasks.find(item => item.id === "remove")?.state, "cleared");
    assert.equal(tasks.find(item => item.id === "keep")?.state, "queued");
    assert.equal((store.getTask("remove")?.events as Array<{ event_type: string }>).some(event => event.event_type === "queue_remove"), true);
  } finally {
    store.close();
    await fs.rm(root, { recursive: true });
  }
});
