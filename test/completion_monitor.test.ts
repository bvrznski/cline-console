import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Logger } from "../src/common/logging";
import { getLegacyWorkspaceActivity, getLegacyWorkspaceSessionStatus, reconcileLegacyStatus, waitForLegacyMessageCompletion, waitForLegacyTaskCompletion, waitForLegacyWorkspaceIdle } from "../src/integrations/cline/completion_monitor";

const logger: Logger = { error() {}, info() {}, debug() {} };

test("completion monitor matches exact prompt, workspace, and terminal status", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-completion-"));
  const id = "session-1", directory = path.join(root, "data", "sessions", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ session_id: id, source: "vscode", workspace_root: "/repo", prompt: "exact\ntext", started_at: new Date().toISOString(), status: "completed", exit_code: 0 }));
  assert.deepEqual(await waitForLegacyTaskCompletion("/repo", "exact\ntext", new Date(Date.now() - 1000).toISOString(), new AbortController().signal, logger, root), { sessionId: id, status: "completed", exitCode: 0 });
  await fs.rm(root, { recursive: true });
});

test("idle monitor ignores stale running sessions whose process is gone", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-idle-"));
  const id = "session-dead", directory = path.join(root, "data", "sessions", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ session_id: id, source: "vscode", workspace_root: "/repo", status: "running", pid: 2_147_483_647 }));
  await waitForLegacyWorkspaceIdle("/repo", new AbortController().signal, logger, root);
  await fs.rm(root, { recursive: true });
});

test("workspace activity reports a live running VS Code session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-activity-"));
  const id = "session-live", directory = path.join(root, "data", "sessions", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ session_id: id, source: "vscode", workspace_root: "/repo", status: "running", pid: process.pid }));
  assert.deepEqual(await getLegacyWorkspaceActivity("/repo", root), { active: true, sessionId: id, status: "running" });
  await fs.rm(root, { recursive: true });
});

test("workspace activity reports a live idle VS Code session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-activity-idle-"));
  const id = "session-idle", directory = path.join(root, "data", "sessions", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ source: "vscode", workspace_root: "/repo", status: "idle", pid: process.pid, session_id: id }));
  assert.deepEqual(await getLegacyWorkspaceActivity("/repo", root), { active: true, sessionId: id, status: "idle" });
  await fs.rm(root, { recursive: true });
});

test("workspace activity protects an idle task whose original extension PID is gone", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-activity-restored-"));
  const id = "session-restored", directory = path.join(root, "data", "sessions", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ source: "vscode", workspace_root: "/repo", status: "idle", pid: 2_147_483_647, session_id: id }));
  assert.deepEqual(await getLegacyWorkspaceActivity("/repo", root), { active: true, sessionId: id, status: "idle" });
  await fs.rm(root, { recursive: true });
});

test("message completion monitor follows the target session from running to idle", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-message-completion-"));
  const id = "session-message", directory = path.join(root, "data", "sessions", id), file = path.join(directory, `${id}.json`);
  await fs.mkdir(directory, { recursive: true });
  const record = { session_id: id, source: "vscode", workspace_root: "/repo", status: "running" };
  await fs.writeFile(file, JSON.stringify(record));
  setTimeout(() => { void fs.writeFile(file, JSON.stringify({ ...record, status: "idle", exit_code: 0 })); }, 50);
  const result = await waitForLegacyMessageCompletion("/repo", id, new AbortController().signal, logger, root);
  assert.equal(result.sessionId, id);
  assert.equal(result.status, "idle");
  assert.equal(result.exitCode, 0);
  await fs.rm(root, { recursive: true });
});

test("latest idle session replaces stale submitted bridge state with completed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-status-"));
  const id = "900", directory = path.join(root, "data", "sessions", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ session_id: id, source: "vscode", workspace_root: "/repo", status: "idle" }));
  const session = await getLegacyWorkspaceSessionStatus("/repo", root);
  const status = reconcileLegacyStatus({ connected: true, task: "active", state: "submitted", observedAt: "2000-01-01T00:00:00.000Z" }, session);
  assert.equal(status.task, "completed");
  assert.equal(status.state, "idle");
  assert.equal(status.taskId, id);
  await fs.rm(root, { recursive: true });
});

test("newer bridge submission wins over stale idle session metadata", () => {
  const status = reconcileLegacyStatus(
    { connected: true, task: "active", state: "submitted", observedAt: "2026-08-10T10:00:00.000Z" },
    { sessionId: "old", status: "idle", observedAt: "2026-08-10T09:00:00.000Z" }
  );
  assert.equal(status.task, "active");
  assert.equal(status.state, "submitted");
});

test("Cline UI task history distinguishes running from completed in the exact workspace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-status-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = "1234";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([
    { id: "older", cwdOnTaskInitialization: "/other" },
    { id, cwdOnTaskInitialization: "/repo", task: "# First line\n\nMore details" }
  ]));
  const messages = path.join(storage, "tasks", id, "ui_messages.json");
  await fs.writeFile(messages, JSON.stringify([{ ts: 1, type: "say", say: "api_req_started" }]));
  const running = await getLegacyWorkspaceSessionStatus("/repo", clineRoot, storage);
  assert.equal(running?.status, "running");
  assert.equal(running?.title, "# First line");
  await fs.writeFile(messages, JSON.stringify([{ ts: 2, type: "ask", ask: "completion_result" }]));
  assert.equal((await getLegacyWorkspaceSessionStatus("/repo", clineRoot, storage))?.status, "completed");
  assert.equal(await getLegacyWorkspaceSessionStatus("/missing", clineRoot, storage), undefined);
  await fs.rm(root, { recursive: true });
});

test("queue completion monitor recognizes a completed Cline UI task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-queue-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "# Queued task\nBody";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
  await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([{ ts: Date.now(), type: "ask", ask: "completion_result" }]));
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Date.now() - 1000).toISOString(), new AbortController().signal, logger, clineRoot, storage);
  assert.deepEqual(result, { sessionId: id, status: "completed" });
  await fs.rm(root, { recursive: true });
});
