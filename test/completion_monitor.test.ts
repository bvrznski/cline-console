import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Logger } from "../src/common/logging";
import { findUnresolvedTestTimeout, getLatestLegacyWorkspaceTaskPrompt, getLegacyNewTaskHandoff, getLegacyWorkspaceActivity, getLegacyWorkspaceSessionStatus, reconcileLegacyStatus, waitForLegacyMessageCompletion, waitForLegacyTaskCompletion, waitForLegacyWorkspaceIdle } from "../src/integrations/cline/completion_monitor";

const logger: Logger = { error() {}, info() {}, debug() {} };

test("test-timeout detector requires a successful rerun of the same scope", () => {
  const timeout = { ts: 10, say: "api_req_started", text: "[execute_command for 'npm test'] Result:\nCommand execution timed out after 30 seconds." };
  assert.deepEqual(findUnresolvedTestTimeout([timeout], "task", "done"), {
    marker: "task:10:done", command: "npm test", text: "Command execution timed out after 30 seconds."
  });
  assert.equal(findUnresolvedTestTimeout([timeout, {
    ts: 11, say: "api_req_started", text: "[execute_command for 'npm test'] Result:\nCommand executed.\nOutput:\n93 tests passed"
  }], "task", "done"), undefined);
  assert.notEqual(findUnresolvedTestTimeout([timeout, {
    ts: 12, say: "api_req_started", text: "[execute_command for 'npm test -- --runInBand other.test.ts'] Result:\nCommand executed.\nOutput:\n1 test passed"
  }], "task", "done"), undefined);
  assert.equal(findUnresolvedTestTimeout([{
    ts: 13, say: "api_req_started", text: "[execute_command for 'python -c \"import package\"'] Result:\nCommand execution timed out after 30 seconds."
  }], "task", "done"), undefined);
});

test("completion monitor matches exact prompt, workspace, and terminal status", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-completion-"));
  const id = "session-1", directory = path.join(root, "data", "sessions", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ session_id: id, source: "vscode", workspace_root: "/repo", prompt: "exact\ntext", started_at: new Date().toISOString(), status: "completed", exit_code: 0 }));
  assert.deepEqual(await waitForLegacyTaskCompletion("/repo", "exact\ntext", new Date(Date.now() - 1000).toISOString(), new AbortController().signal, logger, root, path.join(root, "missing-storage"), { terminalStabilityMs: 0 }), { sessionId: id, status: "completed", exitCode: 0 });
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
  const now = Date.parse("2026-08-10T10:00:10.000Z");
  const status = reconcileLegacyStatus(
    { connected: true, task: "active", state: "submitted", observedAt: "2026-08-10T10:00:00.000Z" },
    { sessionId: "old", status: "idle", observedAt: "2026-08-10T09:00:00.000Z" },
    now
  );
  assert.equal(status.task, "active");
  assert.equal(status.state, "submitted");
});

test("stale bridge submission cannot override completed Cline history", () => {
  const status = reconcileLegacyStatus(
    { connected: true, task: "active", state: "submitted", observedAt: "2026-08-10T10:00:00.000Z" },
    { sessionId: "done", status: "completed", observedAt: "2026-08-10T09:00:00.000Z", title: "Finished task" },
    Date.parse("2026-08-10T10:01:00.000Z")
  );
  assert.equal(status.task, "completed");
  assert.equal(status.state, "completed");
  assert.equal(status.taskId, "done");
});

test("stale bridge submission without Cline history expires", () => {
  const status = reconcileLegacyStatus(
    { connected: true, task: "active", state: "submitted", observedAt: "2026-08-10T10:00:00.000Z", title: "Old task" },
    undefined,
    Date.parse("2026-08-10T10:01:00.000Z")
  );
  assert.equal(status.task, "none");
  assert.equal(status.state, "unknown");
  assert.equal(status.title, undefined);
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

test("Cline resume prompt is incomplete but waiting rather than running", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-waiting-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = "waiting-task";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: "Incomplete task" }]));
  await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([{ ts: 1, type: "ask", ask: "resume_task" }]));
  const session = await getLegacyWorkspaceSessionStatus("/repo", clineRoot, storage);
  assert.equal(session?.status, "waiting");
  const status = reconcileLegacyStatus({ connected: true, task: "unknown", state: "unknown" }, session);
  assert.equal(status.task, "active");
  assert.equal(status.state, "waiting");
  await waitForLegacyWorkspaceIdle("/repo", new AbortController().signal, logger, clineRoot, taskId => taskId === id, storage);
  await fs.rm(root, { recursive: true });
});

test("Cline Task failed error requests recovery even when followed by resume_task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-failed-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "Failure task";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
  await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([
    { ts: 41, type: "say", say: "error", text: "[YOLO MODE] Task failed: Too many consecutive mistakes (3)." },
    { ts: 42, type: "ask", ask: "resume_task" }
  ]));
  const session = await getLegacyWorkspaceSessionStatus("/repo", clineRoot, storage);
  assert.equal(session?.status, "failed");
  assert.equal(session?.errorText, "[YOLO MODE] Task failed: Too many consecutive mistakes (3).");
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Date.now() - 1_000).toISOString(), new AbortController().signal, logger, clineRoot, storage, { terminalStabilityMs: 0 });
  assert.equal(result.status, "task_failed");
  assert.equal(result.failureMarker, `${id}:41`);
  assert.equal(result.errorText, "[YOLO MODE] Task failed: Too many consecutive mistakes (3).");
  await fs.rm(root, { recursive: true });
});

test("a later Cline retry supersedes an earlier Task failed error", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-failed-retry-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now());
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: "Retried task" }]));
  await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([
    { say: "error", text: "Task failed: transient failure" },
    { say: "user_feedback", text: "Retry" },
    { say: "api_req_started" }
  ]));
  assert.equal((await getLegacyWorkspaceSessionStatus("/repo", clineRoot, storage))?.status, "running");
  await fs.rm(root, { recursive: true });
});

test("new-task handoff detection is exact-workspace and ignores an acknowledged handoff", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-new-task-handoff-")), storage = path.join(root, "storage"), id = "handoff";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: "Original task" }]));
  const messages = path.join(storage, "tasks", id, "ui_messages.json");
  await fs.writeFile(messages, JSON.stringify([{ ts: 77, type: "ask", ask: "new_task", text: "Handoff context" }]));
  assert.deepEqual(await getLegacyNewTaskHandoff("/repo", storage), { sessionId: id, marker: `${id}:77`, text: "Handoff context" });
  assert.equal(await getLegacyNewTaskHandoff("/other", storage), undefined);
  await fs.writeFile(messages, JSON.stringify([{ ask: "new_task" }, { say: "user_feedback", text: "Finish in this thread. Do not hand off." }]));
  assert.equal(await getLegacyNewTaskHandoff("/repo", storage), undefined);
  await fs.rm(root, { recursive: true });
});

test("queue completion monitor recognizes a completed Cline UI task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-queue-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "# Queued task\nBody";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
  await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([
    { ts: Date.now() - 1, type: "say", say: "task_progress", text: "- [x] Implement\n- [ ] Validate" },
    { ts: Date.now(), type: "ask", ask: "completion_result" }
  ]));
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Date.now() - 1000).toISOString(), new AbortController().signal, logger, clineRoot, storage, { terminalStabilityMs: 0 });
  assert.equal(result.sessionId, id);
  assert.equal(result.status, "completed");
  assert.equal(result.taskProgressText, "- [x] Implement\n- [ ] Validate");
  await fs.rm(root, { recursive: true });
});

test("queue completion requires a stable terminal signal and resets if Cline runs again", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-stability-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "Stability task";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
  const messages = path.join(storage, "tasks", id, "ui_messages.json");
  await fs.writeFile(messages, JSON.stringify([{ ask: "completion_result" }]));
  setTimeout(() => { void fs.writeFile(messages, JSON.stringify([{ say: "api_req_started" }])); }, 20);
  setTimeout(() => { void fs.writeFile(messages, JSON.stringify([{ ask: "completion_result" }])); }, 50);
  const started = Date.now();
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Date.now() - 1000).toISOString(), new AbortController().signal, logger, clineRoot, storage, { terminalStabilityMs: 40, pollIntervalMs: 5 });
  assert.equal(result.sessionId, id);
  assert.equal(result.status, "completed");
  assert.ok(Date.now() - started >= 85);
  await fs.rm(root, { recursive: true });
});

test("queue completion never advances while Cline offers resume task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-resume-gate-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "Interrupted task";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
  const messages = path.join(storage, "tasks", id, "ui_messages.json");
  await fs.writeFile(messages, JSON.stringify([{ ask: "resume_task" }]));
  setTimeout(() => { void fs.writeFile(messages, JSON.stringify([{ ask: "resume_task" }, { say: "api_req_started" }])); }, 20);
  setTimeout(() => { void fs.writeFile(messages, JSON.stringify([{ ask: "completion_result" }])); }, 60);
  const started = Date.now();
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Date.now() - 1000).toISOString(), new AbortController().signal, logger, clineRoot, storage, { terminalStabilityMs: 20, pollIntervalMs: 5 });
  assert.equal(result.sessionId, id);
  assert.equal(result.status, "completed");
  assert.ok(Date.now() - started >= 75);
  await fs.rm(root, { recursive: true });
});

test("queue monitor reports each context overflow error only once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-overflow-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "Large task";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
  await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([{ ts: 99, type: "say", say: "error", text: "maximum context length exceeded" }]));
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Date.now() - 1000).toISOString(), new AbortController().signal, logger, clineRoot, storage);
  assert.equal(result.status, "context_overflow");
  assert.equal(result.recoveryMarker, `${id}:99`);
  await fs.rm(root, { recursive: true });
});

test("queue completion ignores terminal session fallback until Cline history observes the task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-authority-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "Delayed history task";
  await fs.mkdir(path.join(clineRoot, "data", "sessions", id), { recursive: true });
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.writeFile(path.join(clineRoot, "data", "sessions", id, `${id}.json`), JSON.stringify({ session_id: id, source: "vscode", workspace_root: "/repo", prompt, started_at: new Date().toISOString(), status: "completed", exit_code: 0 }));
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), "[]");
  setTimeout(async () => {
    await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
    await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
    await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([{ ask: "completion_result" }]));
  }, 40);
  const started = Date.now();
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Date.now() - 1000).toISOString(), new AbortController().signal, logger, clineRoot, storage, { terminalStabilityMs: 10, pollIntervalMs: 5 });
  assert.equal(result.sessionId, id);
  assert.equal(result.status, "completed");
  assert.ok(Date.now() - started >= 45);
  await fs.rm(root, { recursive: true });
});

test("queue completion monitor skips a task deleted from Cline history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-deleted-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "Deleted queued task";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  const historyFile = path.join(storage, "state", "taskHistory.json");
  await fs.writeFile(historyFile, JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
  await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([{ ts: Date.now(), type: "say", say: "text" }]));
  setTimeout(() => { void fs.writeFile(historyFile, "[]"); }, 30);
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Date.now() - 1000).toISOString(), new AbortController().signal, logger, clineRoot, storage, { deletionGraceMs: 1_000, pollIntervalMs: 10 });
  assert.deepEqual(result, { sessionId: id, status: "deleted" });
  await fs.rm(root, { recursive: true });
});

test("queue completion monitor skips an already-observed persisted task after grace", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-missing-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage");
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), "[]");
  const result = await waitForLegacyTaskCompletion("/repo", "Missing task", new Date(Date.now() - 60_000).toISOString(), new AbortController().signal, logger, clineRoot, storage, { knownSessionId: "missing-session", deletionGraceMs: 20, pollIntervalMs: 5 });
  assert.deepEqual(result, { sessionId: "missing-session", status: "deleted" });
  await fs.rm(root, { recursive: true });
});

test("latest task prompt is read from exact workspace Cline history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-reload-"));
  const storage = path.join(root, "storage");
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([
    { id: "other", cwdOnTaskInitialization: "/other", task: "wrong" },
    { id: "old", cwdOnTaskInitialization: "/repo", task: "old prompt" },
    { id: "latest", cwdOnTaskInitialization: "/repo", task: "# Reload me\nFull private prompt" }
  ]));
  assert.deepEqual(await getLatestLegacyWorkspaceTaskPrompt("/repo", path.join(root, "cline"), storage), { sessionId: "latest", prompt: "# Reload me\nFull private prompt" });
  assert.equal(await getLatestLegacyWorkspaceTaskPrompt("/missing", path.join(root, "cline"), storage), undefined);
  await fs.rm(root, { recursive: true });
});
