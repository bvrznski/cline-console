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
