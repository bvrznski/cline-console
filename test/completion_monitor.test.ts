import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Logger } from "../src/common/logging";
import { findUnresolvedTestTimeout, findUserConfirmedDone, getLatestLegacyWorkspaceTaskPrompt, getLegacyNewTaskHandoff, getLegacyWorkspaceActivity, getLegacyWorkspaceSessionStatus, getOwnedLegacyTaskActivity, hasImplementationActivitySince, MANUAL_COMPLETED_TASK_RESUME_GAP_MS, reconcileLegacyStatus, UI_RUNNING_STALE_MS, waitForLegacyMessageCompletion, waitForLegacyNewTaskHandoffAcknowledgement, waitForLegacyTaskCompletion, waitForLegacyWorkspaceIdle, waitForLegacyWorkspaceIdleStability } from "../src/integrations/cline/completion_monitor";

const logger: Logger = { error() {}, info() {}, debug() {} };

test("standalone DONE accepts only explicit user feedback", () => {
  assert.equal(findUserConfirmedDone([
    { ts: 100, say: "completion_result", text: "DONE" },
    { ts: 101, say: "user_feedback", text: "done with the tests" },
    { ts: 102, say: "user_feedback", text: "  DONE  " }
  ], "session", 100), "session:102");
  assert.equal(findUserConfirmedDone([{ ts: 99, say: "user_feedback", text: "DONE" }], "session", 100), undefined);
});

test("completion monitor immediately returns a standalone user DONE override", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-done-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "Owned queued task";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
  await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([
    { ts: Number(id), type: "say", say: "task", text: prompt },
    { ts: Number(id) + 1, type: "say", say: "user_feedback", text: "DONE" },
    { ts: Number(id) + 2, type: "say", say: "text", text: "This later activity must not delay the override." }
  ]));
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Number(id) - 1_000).toISOString(), new AbortController().signal, logger, clineRoot, storage, { knownSessionId: id, terminalStabilityMs: 60_000 });
  assert.equal(result.status, "user_confirmed_done");
  assert.equal(result.userConfirmedDoneMarker, `${id}:${Number(id) + 1}`);
  await fs.rm(root, { recursive: true });
});

test("completion verification detects implementation but ignores read-only validation", () => {
  const before = { ts: 100, ask: "completion_result", text: "Initial completion" };
  const feedback = { ts: 101, say: "user_feedback", text: "Verify every criterion" };
  const readOnly = { ts: 102, say: "api_req_started", text: "[execute_command for 'npm test'] Result:\nCommand executed.\nOutput:\n118 tests passed" };
  assert.equal(hasImplementationActivitySince([before, feedback, readOnly], "task:100"), false);
  const edit = { ts: 103, say: "api_req_started", text: "[replace_in_file for 'src/app.ts'] Result:\nDone" };
  assert.equal(hasImplementationActivitySince([before, feedback, readOnly, edit], "task:100"), true);
  const shellEdit = { ts: 104, say: "api_req_started", text: "[execute_command for 'git apply fix.patch'] Result:\nCommand executed." };
  assert.equal(hasImplementationActivitySince([before, feedback, shellEdit], "task:100"), true);
});

test("clean CMake rebuild does not retrigger verification but source mutations do", () => {
  const changed = (command: string) => hasImplementationActivitySince([
    { ts: 100, say: "completion_result", text: "Done" },
    { ts: 101, text: `[execute_command for '${command}'] Result:\nCommand executed.` }
  ], "task:100");
  assert.equal(changed("cd /repo/cpp && rm -rf build && cmake -S . -B build"), false);
  assert.equal(changed("rm -rf /repo/cpp/build && cd /repo/cpp && cmake -S . -B build"), false);
  assert.equal(changed("rm -rf src && cmake -S . -B build"), true);
  assert.equal(changed("rm -rf build && cmake -S . -B build && git apply fix.patch"), true);
  assert.equal(changed("rm -rf build && cmake -S . -B other"), true);
});

test("compiler test-binary cleanup does not masquerade as implementation activity", () => {
  const marker = "session:100";
  const validation = [{ ts: 101, text: "[execute_command for 'g++ -std=c++20 tests/unit/test.cpp -Isrc -o test_phase8_17 2>&1; if [ $? -eq 0 ]; then ./test_phase8_17; rm -f test_phase8_17; fi'] Result:\nCommand executed.\nOutput:\nAll tests passed" }];
  assert.equal(hasImplementationActivitySince(validation, marker), false);
  const sourceRemoval = [{ ts: 101, text: "[execute_command for 'g++ test.cpp -o test_bin && rm -f test_bin src/obsolete.cpp'] Result:\nCommand executed.\nOutput:" }];
  assert.equal(hasImplementationActivitySince(sourceRemoval, marker), true);
});

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

test("idle monitors ignore an explicitly finalized session still reported as running", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-idle-finalized-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = "finalized-session";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: "Completed queue item" }]));
  await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([{ ts: Date.now(), type: "say", say: "api_req_started" }]));
  const ignored = (sessionId: string): boolean => sessionId === id;
  await assert.doesNotReject(waitForLegacyWorkspaceIdle("/repo", new AbortController().signal, logger, clineRoot, ignored, storage));
  await assert.doesNotReject(waitForLegacyWorkspaceIdleStability("/repo", 1, new AbortController().signal, logger, clineRoot, ignored, storage, 1));
  await fs.rm(root, { recursive: true });
});

test("workspace activity reports a live running VS Code session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-activity-"));
  const id = "session-live", directory = path.join(root, "data", "sessions", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ session_id: id, source: "vscode", workspace_root: "/repo", status: "running", pid: process.pid }));
  assert.deepEqual(await getLegacyWorkspaceActivity("/repo", root).then(({ observedAt: _observedAt, ...activity }) => activity), { active: true, sessionId: id, status: "running" });
  await fs.rm(root, { recursive: true });
});

test("workspace activity reports a live idle VS Code session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-activity-idle-"));
  const id = "session-idle", directory = path.join(root, "data", "sessions", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ source: "vscode", workspace_root: "/repo", status: "idle", pid: process.pid, session_id: id }));
  assert.deepEqual(await getLegacyWorkspaceActivity("/repo", root).then(({ observedAt: _observedAt, ...activity }) => activity), { active: true, sessionId: id, status: "idle" });
  await fs.rm(root, { recursive: true });
});

test("workspace activity protects an idle task whose original extension PID is gone", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-activity-restored-"));
  const id = "session-restored", directory = path.join(root, "data", "sessions", id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${id}.json`), JSON.stringify({ source: "vscode", workspace_root: "/repo", status: "idle", pid: 2_147_483_647, session_id: id }));
  assert.deepEqual(await getLegacyWorkspaceActivity("/repo", root).then(({ observedAt: _observedAt, ...activity }) => activity), { active: true, sessionId: id, status: "idle" });
  await fs.rm(root, { recursive: true });
});

test("owned activity finds a recovered exact-prompt task omitted from shared history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-owned-activity-"));
  const prompt = "# Exact queued task";
  const stale = path.join(root, "tasks", "stale"), recovered = path.join(root, "tasks", "recovered");
  await fs.mkdir(stale, { recursive: true });
  await fs.mkdir(recovered, { recursive: true });
  await fs.writeFile(path.join(stale, "ui_messages.json"), JSON.stringify([
    { ts: 1, say: "task", text: prompt },
    { ts: 2, ask: "completion_result", text: "old completion" }
  ]));
  await fs.writeFile(path.join(recovered, "ui_messages.json"), JSON.stringify([
    { ts: 3, say: "task", text: prompt },
    { ts: 4, say: "api_req_started", text: "working" }
  ]));
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(path.join(stale, "ui_messages.json"), old, old);

  const activity = await getOwnedLegacyTaskActivity(["unrelated", "stale", "recovered"], prompt, root);
  assert.equal(activity?.sessionId, "recovered");
  assert.equal(activity?.status, "running");
  assert.equal(activity?.active, true);
  await fs.rm(root, { recursive: true });
});

test("owned activity never adopts an exact-prompt session older than the current dispatch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-owned-activity-dispatch-"));
  const prompt = "# Repeated queued task";
  const previous = path.join(root, "tasks", "previous");
  await fs.mkdir(previous, { recursive: true });
  await fs.writeFile(path.join(previous, "ui_messages.json"), JSON.stringify([
    { ts: 1, say: "task", text: prompt },
    { ts: 2, ask: "completion_result", text: "old completion" }
  ]));
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(path.join(previous, "ui_messages.json"), old, old);

  const activity = await getOwnedLegacyTaskActivity(
    ["previous"],
    prompt,
    root,
    new Date(old.getTime() + 30_000).toISOString()
  );
  assert.equal(activity, undefined);
  await fs.rm(root, { recursive: true });
});

test("stale UI-only activity cannot remain running forever", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-stale-ui-"));
  const clineRoot = path.join(root, "cline"), storage = path.join(root, "storage"), id = "stale-ui";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: "Stale task" }]));
  const messages = path.join(storage, "tasks", id, "ui_messages.json");
  await fs.writeFile(messages, JSON.stringify([{ ts: 1, say: "api_req_started", text: "old request" }]));
  const old = new Date(Date.now() - UI_RUNNING_STALE_MS - 1_000);
  await fs.utimes(messages, old, old);
  const session = await getLegacyWorkspaceSessionStatus("/repo", clineRoot, storage);
  assert.equal(session?.status, "stale");
  assert.deepEqual(await getLegacyWorkspaceActivity("/repo", clineRoot, storage), { active: false });
  const status = reconcileLegacyStatus({ connected: true, task: "active", state: "submitted", observedAt: old.toISOString() }, session);
  assert.equal(status.task, "none");
  assert.equal(status.state, "idle");
  assert.equal(status.taskId, undefined);
  assert.equal(status.title, undefined);
  assert.equal(status.detail, "No task is running in this workspace.");
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

test("Cline resume-completed control remains terminal instead of appearing to run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-resume-completed-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "Completed queued task";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
  await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([
    { ts: Number(id), say: "task", text: prompt },
    { ts: Number(id) + 1, say: "completion_result", text: "All requested work is complete." },
    { ts: Number(id) + 2, ask: "resume_completed_task" }
  ]));
  try {
    assert.equal((await getLegacyWorkspaceSessionStatus("/repo", clineRoot, storage))?.status, "completed");
    const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Number(id) - 1_000).toISOString(), new AbortController().signal, logger, clineRoot, storage, {
      knownSessionId: id, terminalStabilityMs: 0, pollIntervalMs: 5
    });
    assert.equal(result.status, "completed");
    assert.equal(result.completionText, "All requested work is complete.");
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("a delayed manual resume of a completed owned thread appears to run for arbitration", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-manual-resume-completed-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "Completed queued task";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
  await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([
    { ts: Number(id), say: "task", text: prompt },
    { ts: Number(id) + 1, say: "completion_result", text: "All requested work is complete." },
    { ts: Number(id) + MANUAL_COMPLETED_TASK_RESUME_GAP_MS + 1, ask: "resume_completed_task" }
  ]));
  try {
    assert.equal((await getLegacyWorkspaceSessionStatus("/repo", clineRoot, storage))?.status, "running");
    assert.equal((await getLegacyWorkspaceActivity("/repo", clineRoot, storage)).status, "running");
  } finally {
    await fs.rm(root, { recursive: true });
  }
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

test("recovery adopts a newer exact-prompt Cline session instead of pinning the failed predecessor", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-successor-"));
  const storage = path.join(root, "storage");
  const state = path.join(storage, "state");
  const tasks = path.join(storage, "tasks");
  await fs.mkdir(state, { recursive: true });
  const prompt = "recover this exact task";
  const oldId = "1789000000000";
  const newId = "1789000001000";
  await fs.writeFile(path.join(state, "taskHistory.json"), JSON.stringify([
    { id: oldId, task: prompt, cwdOnTaskInitialization: "/repo" },
    { id: newId, task: prompt, cwdOnTaskInitialization: "/repo" }
  ]));
  await fs.mkdir(path.join(tasks, oldId), { recursive: true });
  await fs.mkdir(path.join(tasks, newId), { recursive: true });
  const failureText = "[YOLO MODE] Task failed: Too many consecutive mistakes (3).";
  await fs.writeFile(path.join(tasks, oldId, "ui_messages.json"), JSON.stringify([{ ts: 10, type: "say", say: "error", text: failureText }]));
  await fs.writeFile(path.join(tasks, newId, "ui_messages.json"), JSON.stringify([{ ts: 20, type: "say", say: "completion_result", text: "done" }]));
  try {
    const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Number(oldId) - 1_000).toISOString(), new AbortController().signal, logger, path.join(root, "missing-cline"), storage, {
      knownSessionId: oldId,
      afterFailureMarker: `${oldId}:10`,
      terminalStabilityMs: 0,
      pollIntervalMs: 5
    });
    assert.equal(result.sessionId, newId);
    assert.equal(result.status, "completed");
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("completion monitor follows a queue-owned session replacement made while it is running", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-live-adoption-"));
  const storage = path.join(root, "storage"), state = path.join(storage, "state"), tasks = path.join(storage, "tasks");
  const prompt = "reload this exact task", oldId = "1789000010000", newId = "1789000011000";
  await fs.mkdir(state, { recursive: true });
  await fs.mkdir(path.join(tasks, oldId), { recursive: true });
  await fs.mkdir(path.join(tasks, newId), { recursive: true });
  await fs.writeFile(path.join(state, "taskHistory.json"), JSON.stringify([
    { id: oldId, task: prompt, cwdOnTaskInitialization: "/repo" },
    { id: newId, task: prompt, cwdOnTaskInitialization: "/repo" }
  ]));
  await fs.writeFile(path.join(tasks, oldId, "ui_messages.json"), JSON.stringify([{ ts: 10, say: "api_req_started" }]));
  await fs.writeFile(path.join(tasks, newId, "ui_messages.json"), JSON.stringify([{ ts: 20, ask: "completion_result", text: "done" }]));
  let currentId = oldId;
  setTimeout(() => { currentId = newId; }, 20);
  try {
    const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Number(oldId) - 1_000).toISOString(), new AbortController().signal, logger, path.join(root, "missing-cline"), storage, {
      knownSessionId: oldId,
      currentSessionId: () => currentId,
      terminalStabilityMs: 10,
      pollIntervalMs: 5
    });
    assert.equal(result.sessionId, newId);
    assert.equal(result.status, "completed");
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("YOLO failure detector handles structured and wording variants without source-code false positives", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-yolo-variants-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now());
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: "YOLO variants" }]));
  const messages = path.join(storage, "tasks", id, "ui_messages.json");
  await fs.writeFile(messages, JSON.stringify([
    { say: "api_req_started", text: "source = logger.error('Task failed: example')" },
    { ts: 51, type: "error", text: JSON.stringify({ error: { message: "[YOLO MODE] Automatic execution stopped after the maximum number of consecutive mistakes." } }) }
  ]));
  const session = await getLegacyWorkspaceSessionStatus("/repo", clineRoot, storage);
  assert.equal(session?.status, "failed");
  assert.match(session?.errorText ?? "", /YOLO MODE.*stopped.*consecutive mistakes/i);

  await fs.writeFile(messages, JSON.stringify([
    { ts: 52, say: "error", text: "Too many consecutive mistakes (3)." },
    { say: "api_req_started", text: "unrelated automatic record" }
  ]));
  assert.equal((await getLegacyWorkspaceSessionStatus("/repo", clineRoot, storage))?.status, "failed");

  await fs.writeFile(messages, JSON.stringify([
    { ts: 53, say: "error", text: "Too many consecutive mistakes (3)." },
    { ask: "resume_task" },
    { say: "api_req_started", text: "retry started" }
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
  assert.deepEqual(await getLegacyNewTaskHandoff("/repo", storage), { sessionId: id, marker: `${id}:77`, text: "Handoff context", repeatCount: 1 });
  assert.equal(await getLegacyNewTaskHandoff("/other", storage), undefined);
  await fs.writeFile(messages, JSON.stringify([{ ask: "new_task" }, { say: "user_feedback", text: "continue in this thread" }]));
  assert.equal(await getLegacyNewTaskHandoff("/repo", storage), undefined);
  await fs.writeFile(messages, JSON.stringify([
    { ts: 78, ask: "new_task", text: "another handoff" },
    { say: "user_feedback", text: "Do not start or spawn a new task. Continue the current original task in this exact same Cline thread." }
  ]));
  assert.equal(await getLegacyNewTaskHandoff("/repo", storage), undefined);
  await fs.rm(root, { recursive: true });
});

test("new-task handoff remains detectable after Cline rolls to a successor task", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-new-task-rollover-")), storage = path.join(root, "storage");
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  for (const id of ["predecessor", "successor"]) await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([
    { id: "predecessor", cwdOnTaskInitialization: "/repo" },
    { id: "successor", cwdOnTaskInitialization: "/repo" }
  ]));
  await fs.writeFile(path.join(storage, "tasks", "predecessor", "ui_messages.json"), JSON.stringify([
    { ts: 91, type: "ask", ask: "new_task", text: "Work that must remain in the original thread" }
  ]));
  await fs.writeFile(path.join(storage, "tasks", "successor", "ui_messages.json"), JSON.stringify([
    { ts: 92, type: "say", say: "api_req_started" }
  ]));
  assert.deepEqual(await getLegacyNewTaskHandoff("/repo", storage), {
    sessionId: "predecessor",
    marker: "predecessor:91",
    text: "Work that must remain in the original thread",
    repeatCount: 1
  });
  await fs.rm(root, { recursive: true });
});

test("latest unresolved new-task handoff remains actionable after a long pause", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-new-task-paused-")), storage = path.join(root, "storage"), id = "paused";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo" }]));
  const messages = path.join(storage, "tasks", id, "ui_messages.json");
  await fs.writeFile(messages, JSON.stringify([{ ts: 93, ask: "new_task", text: "paused handoff" }, { ask: "resume_task" }]));
  const old = new Date(Date.now() - UI_RUNNING_STALE_MS - 60_000);
  await fs.utimes(messages, old, old);
  assert.deepEqual(await getLegacyNewTaskHandoff("/repo", storage), { sessionId: id, marker: `${id}:93`, text: "paused handoff", repeatCount: 1 });
  await fs.rm(root, { recursive: true });
});

test("new-task handoff is handled only after Cline records same-thread delivery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-new-task-ack-")), storage = path.join(root, "storage"), id = "ack-task";
  const directory = path.join(storage, "tasks", id), messages = path.join(directory, "ui_messages.json");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(messages, JSON.stringify([{ ts: 101, type: "ask", ask: "new_task", text: "remaining work" }, { ask: "resume_task" }]));
  const handoff = { sessionId: id, marker: `${id}:101`, text: "remaining work", repeatCount: 1 };
  assert.equal(await waitForLegacyNewTaskHandoffAcknowledgement(handoff, new AbortController().signal, storage, 10), false);
  setTimeout(() => { void fs.writeFile(messages, JSON.stringify([
    { ts: 101, type: "ask", ask: "new_task", text: "remaining work" },
    { ask: "resume_task" },
    { say: "user_feedback", text: "[cline-console:same-thread-handoff]\nContinue the current original task in this exact same Cline thread." }
  ])); }, 25);
  assert.equal(await waitForLegacyNewTaskHandoffAcknowledgement(handoff, new AbortController().signal, storage, 1_000), true);
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
    { ts: Date.now(), type: "say", say: "completion_result", text: "## Next Steps\n1. Validate the runtime" },
    { ts: Date.now(), type: "ask", ask: "completion_result" }
  ]));
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Date.now() - 1000).toISOString(), new AbortController().signal, logger, clineRoot, storage, { terminalStabilityMs: 0 });
  assert.equal(result.sessionId, id);
  assert.equal(result.status, "completed");
  assert.equal(result.completionText, "## Next Steps\n1. Validate the runtime");
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
  setTimeout(() => { void Promise.all([fs.writeFile(historyFile, "[]"), fs.rm(path.join(storage, "tasks", id), { recursive: true })]); }, 30);
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Date.now() - 1000).toISOString(), new AbortController().signal, logger, clineRoot, storage, { deletionGraceMs: 1_000, pollIntervalMs: 10 });
  assert.deepEqual(result, { sessionId: id, status: "deleted" });
  await fs.rm(root, { recursive: true });
});

test("queue completion keeps monitoring its transcript during another workspace history rewrite", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-cross-workspace-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "Queued workspace task";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  const historyFile = path.join(storage, "state", "taskHistory.json");
  const messagesFile = path.join(storage, "tasks", id, "ui_messages.json");
  await fs.writeFile(historyFile, JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
  await fs.writeFile(messagesFile, JSON.stringify([{ say: "task", text: prompt }, { say: "api_req_started" }]));
  setTimeout(() => { void fs.writeFile(historyFile, JSON.stringify([{ id: "manual", cwdOnTaskInitialization: "/other", task: "Manual task" }])); }, 10);
  setTimeout(() => { void fs.writeFile(messagesFile, JSON.stringify([{ say: "task", text: prompt }, { say: "completion_result", text: "Done" }])); }, 50);
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Date.now() - 1_000).toISOString(), new AbortController().signal, logger, clineRoot, storage, { knownSessionId: id, deletionGraceMs: 20, terminalStabilityMs: 10, pollIntervalMs: 5 });
  assert.equal(result.sessionId, id);
  assert.equal(result.status, "completed");
  await fs.rm(root, { recursive: true });
});

test("queue completion reports Cline edits outside the declared task scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ui-scope-"));
  const clineRoot = path.join(root, "sessions-root"), storage = path.join(root, "storage"), id = String(Date.now()), prompt = "Scoped task";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: prompt }]));
  await fs.writeFile(path.join(storage, "tasks", id, "ui_messages.json"), JSON.stringify([{ say: "task", text: prompt }, { say: "api_req_started" }]));
  await fs.writeFile(path.join(storage, "tasks", id, "task_metadata.json"), JSON.stringify({ files_in_context: [
    { path: "src/in-scope.ts", cline_edit_date: Date.now() },
    { path: "docs/outside.md", cline_edit_date: Date.now() },
    { path: "README.md", record_source: "read_tool", cline_edit_date: null }
  ] }));
  const result = await waitForLegacyTaskCompletion("/repo", prompt, new Date(Date.now() - 1_000).toISOString(), new AbortController().signal, logger, clineRoot, storage, { knownSessionId: id, scopePath: "/repo/src", pollIntervalMs: 5 });
  assert.equal(result.status, "scope_violation");
  assert.deepEqual(result.violatingPaths, ["/repo/docs/outside.md"]);
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

test("workspace idle monitor treats queue cancellation as a clean stop", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.doesNotReject(waitForLegacyWorkspaceIdle("/repo", controller.signal, logger));
});

test("restart idle monitor requires a continuous stable idle interval", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-restart-idle-"));
  const clineRoot = path.join(root, "cline"), storage = path.join(root, "storage"), id = "restart-task";
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.mkdir(path.join(storage, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([{ id, cwdOnTaskInitialization: "/repo", task: "Task" }]));
  const messages = path.join(storage, "tasks", id, "ui_messages.json");
  await fs.writeFile(messages, JSON.stringify([{ ts: Date.now(), say: "completion_result" }]));
  const started = Date.now();
  setTimeout(() => { void fs.writeFile(messages, JSON.stringify([{ ts: Date.now(), say: "api_req_started" }])); }, 15);
  setTimeout(() => { void fs.writeFile(messages, JSON.stringify([{ ts: Date.now(), say: "completion_result" }])); }, 35);
  await waitForLegacyWorkspaceIdleStability("/repo", 40, new AbortController().signal, logger, clineRoot, () => false, storage, 5);
  assert.ok(Date.now() - started >= 70, "activity should reset the stable-idle clock");
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
