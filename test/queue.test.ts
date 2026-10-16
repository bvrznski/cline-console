import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatQueue, formatQueues } from "../src/client/commands/queue";
import { auditRecommendationFollowup, buildQueueStatus, calculateTaskTiming, checkpointTaskTimer, completionCorrectionState, completionVerificationDecision, completionVerificationFollowup, DEFAULT_TASK_SCANNER_OPTIONS, deliverTaskBoundMessage, discoverPersistedQueueStatuses, incompleteCompletionFollowup, isYoloConsecutiveMistakesFailure, newTaskHandoffFollowup, newTaskHandoffKey, newTaskHandoffPolicy, queueResumeContinuationRequired, readQueueStatusFile, reconcileQueueStatus, recoveryContinuationRequired, reflectiveCompletionFollowup, remainingTaskDispatchDelay, rememberIgnoredSession, restartRecoveryContinuationRequired, restartRecoveryDisposition, scopeViolationFollowup, selectUnhandledAuditRecommendations, sessionReplacementAllowed, shouldRequestYoloRestart, taskTimerShouldRun, TaskQueue, terminalQueueRemovalAllowed, testTimeoutFollowup, yoloFailureDiagnosticFollowup, yoloFreshRecoveryRequired } from "../src/extension/task_queue";
import { extractCompletionConfidence } from "../src/extension/task_queue";
import type { ClineAdapter } from "../src/integrations/cline/types";
import type { Logger } from "../src/common/logging";
import { deleteLegacyQueuedTaskHistory, deleteLegacyWorkspaceTaskHistory, getLegacyUnfinishedWorkspaceTasks } from "../src/integrations/cline/task_history";

const logger: Logger = { error() {}, info() {}, debug() {} };

test("repeated incomplete completion claims require an original-stage audit", () => {
  assert.doesNotMatch(incompleteCompletionFollowup(1), /repeatedly claimed completion/);
  const remaining = ["Fix relative imports", "Create tests - COMPLETED", "Validate runtime startup"];
  assert.match(incompleteCompletionFollowup(1, remaining), /scanner detected these concrete remaining steps/i);
  const followup = incompleteCompletionFollowup(2, remaining);
  assert.match(followup, /Re-read the complete original task prompt/);
  assert.match(followup, /1\. \"Fix relative imports\"/);
  assert.match(followup, /2\. \"Create tests - COMPLETED\"/);
  assert.match(followup, /3\. \"Validate runtime startup\"/);
  assert.match(followup, /resolve the contradiction/i);
  assert.doesNotMatch(followup, /\"Inspect\"/);
});

test("completion correction stops after five unchanged STOP responses and resets on implementation", () => {
  let state = completionCorrectionState(2, undefined, false, 5);
  assert.deepEqual(state, { unchangedRounds: 0, limitReached: false });
  for (let claim = 3; claim <= 6; claim += 1) {
    state = completionCorrectionState(claim, state.unchangedRounds, false, 5);
    assert.equal(state.limitReached, false);
  }
  state = completionCorrectionState(7, state.unchangedRounds, false, 5);
  assert.deepEqual(state, { unchangedRounds: 5, limitReached: true });
  assert.deepEqual(completionCorrectionState(8, 4, true, 5), { unchangedRounds: 0, limitReached: false });
});

test("test timeout follow-up requires bounded regression coverage and a full rerun", () => {
  const followup = testTimeoutFollowup("python -m pytest tests -v");
  assert.match(followup, /python -m pytest tests -v/);
  assert.match(followup, /bounded timeout and cleanup path/);
  assert.match(followup, /regression test/);
  assert.match(followup, /not merely a narrower substitute/);
  assert.match(followup, /do not reinterpret a timeout as a pass/i);
});

test("automatic workspace restart is limited to the explicit YOLO three-mistake failure", () => {
  assert.equal(isYoloConsecutiveMistakesFailure("[YOLO MODE] Task failed: Too many consecutive mistakes (3)."), true);
  assert.equal(isYoloConsecutiveMistakesFailure("YOLO MODE stopped after 3 consecutive mistakes"), true);
  assert.equal(isYoloConsecutiveMistakesFailure("Task failed: Too many consecutive mistakes (3)."), false);
  assert.equal(isYoloConsecutiveMistakesFailure("[YOLO MODE] ordinary provider timeout"), false);
});

test("YOLO restart policy restarts each failure marker only once", () => {
  const error = "[YOLO MODE] Task failed: Too many consecutive mistakes (3).";
  assert.equal(shouldRequestYoloRestart(error, "session:failure-1"), true);
  assert.equal(shouldRequestYoloRestart(error, "session:failure-1", "session:failure-1"), false);
  assert.equal(shouldRequestYoloRestart(error, "session:failure-2", "session:failure-1"), true);
  assert.match(yoloFailureDiagnosticFollowup(), /diagnose why/i);
  assert.match(yoloFailureDiagnosticFollowup(), /same task/i);
});

test("YOLO restart opens exactly one fresh recovery session per failure marker", () => {
  assert.equal(yoloFreshRecoveryRequired(undefined, undefined), false);
  assert.equal(yoloFreshRecoveryRequired("failure-1", undefined), true);
  assert.equal(yoloFreshRecoveryRequired("failure-1", "failure-1"), false);
  assert.equal(yoloFreshRecoveryRequired("failure-2", "failure-1"), true);
});

test("restart recovery suppresses stale continuation after completion or successor adoption", () => {
  assert.equal(recoveryContinuationRequired("old"), true);
  assert.equal(recoveryContinuationRequired("old", { sessionId: "old", status: "failed" }), true);
  assert.equal(recoveryContinuationRequired("old", { sessionId: "old", status: "completed" }), false);
  assert.equal(recoveryContinuationRequired("old", { sessionId: "new", status: "running" }), false);
  assert.equal(recoveryContinuationRequired("old", { sessionId: "new", status: "waiting" }), false);
  assert.equal(recoveryContinuationRequired("old", { sessionId: "new", status: "completed" }), false);
});

test("queue resume actively continues only its exact waiting Cline session", () => {
  assert.equal(queueResumeContinuationRequired({ active: true, status: "waiting", sessionId: "owned" }, "owned"), true);
  assert.equal(queueResumeContinuationRequired({ active: true, status: "running", sessionId: "owned" }, "owned"), false);
  assert.equal(queueResumeContinuationRequired({ active: false, status: "completed", sessionId: "owned" }, "owned"), false);
  assert.equal(queueResumeContinuationRequired({ active: true, status: "waiting", sessionId: "other" }, "owned"), false);
  assert.equal(queueResumeContinuationRequired({ active: true, status: "waiting" }, "owned"), false);
});

test("legacy numeric Cline sessions can advance but never regress", () => {
  assert.equal(sessionReplacementAllowed(undefined, "1791760862891"), true);
  assert.equal(sessionReplacementAllowed("1791760826218", "1791760862891"), true);
  assert.equal(sessionReplacementAllowed("1791760862891", "1791760862891"), true);
  assert.equal(sessionReplacementAllowed("1791760862891", "1791760826218"), false);
  assert.equal(sessionReplacementAllowed("opaque-a", "opaque-b"), true);
});

test("completion verification repeats only after implementation activity", () => {
  assert.equal(completionVerificationDecision(false, false), "request_initial");
  assert.equal(completionVerificationDecision(false, true), "request_initial");
  assert.equal(completionVerificationDecision(true, true), "request_after_implementation");
  assert.equal(completionVerificationDecision(true, true, 90, 90), "accept");
  assert.equal(completionVerificationDecision(true, true, 89, 90), "request_after_implementation");
  assert.equal(completionVerificationDecision(true, false), "accept");
  assert.equal(completionVerificationDecision(true, true, undefined, 90, 2, 3), "request_after_implementation");
  assert.equal(completionVerificationDecision(true, true, undefined, 90, 3, 3), "accept");
  assert.equal(completionVerificationDecision(true, true, 89, 90, 3, 3), "accept");
  assert.match(completionVerificationFollowup(false), /perform one final completion verification/i);
  assert.match(completionVerificationFollowup(true), /previous verification pass made implementation changes/i);
  assert.match(completionVerificationFollowup(true), /exact same task/i);
  assert.match(completionVerificationFollowup(false), /COMPLETION_CONFIDENCE: N%/);
  assert.match(completionVerificationFollowup(false), /at least 90%/);
  assert.equal(extractCompletionConfidence("Evidence\nCOMPLETION_CONFIDENCE: 94%"), 94);
  assert.equal(extractCompletionConfidence("I am 99% confident"), undefined);
});

test("task-bound messages select the owned session before bounded delivery", async () => {
  const calls: string[] = [];
  const adapter: ClineAdapter = {
    ...adapterWithStatus("none", "unknown"),
    resumeTask: async sessionId => { calls.push(`select:${sessionId}`); return { taskStarted: true, taskId: sessionId }; },
    sendMessage: async message => { calls.push(`send:${message}`); }
  };
  await deliverTaskBoundMessage(adapter, "owned-session", "verify", "completion verification", new AbortController().signal, true, true, 0, 50);
  assert.deepEqual(calls, ["select:owned-session", "send:verify"]);
});

test("task-bound messages fail closed for unowned sessions and hung delivery", async () => {
  const calls: string[] = [];
  const adapter: ClineAdapter = {
    ...adapterWithStatus("none", "unknown"),
    resumeTask: async sessionId => { calls.push(`select:${sessionId}`); return { taskStarted: true, taskId: sessionId }; },
    sendMessage: async () => { calls.push("send"); }
  };
  await assert.rejects(deliverTaskBoundMessage(adapter, "manual-session", "verify", "completion verification", new AbortController().signal, false, true, 0, 50), /not owned by cline-console/i);
  assert.deepEqual(calls, []);

  const hung: ClineAdapter = { ...adapter, sendMessage: async () => new Promise<void>(() => {}) };
  await assert.rejects(deliverTaskBoundMessage(hung, "owned-session", "verify", "completion verification", new AbortController().signal, true, true, 0, 10), /timed out delivering completion verification/i);
});

test("task-bound message delivery is cancelled immediately when queue shutdown aborts it", async () => {
  const controller = new AbortController();
  const hung: ClineAdapter = {
    ...adapterWithStatus("none", "unknown"),
    resumeTask: async () => new Promise<never>(() => {}),
    sendMessage: async () => new Promise<void>(() => {})
  };
  const started = Date.now();
  const delivery = deliverTaskBoundMessage(hung, "owned-session", "verify", "completion verification", controller.signal, true, true, 0, 30_000);
  controller.abort();
  await assert.rejects(delivery, /queue monitor stopped/i);
  assert.ok(Date.now() - started < 1_000, "abort should not wait for the adapter timeout");
});

test("audit recommendation follow-up requires implementation and a post-remediation report", () => {
  const followup = auditRecommendationFollowup(["Restrict SSH access", "Add regression tests"]);
  assert.match(followup, /same task/);
  assert.match(followup, /1\. "Restrict SSH access"/);
  assert.match(followup, /2\. "Add regression tests"/);
  assert.match(followup, /post-remediation report/);
  assert.match(followup, /residual risk/);
  assert.doesNotMatch(auditRecommendationFollowup(["Fix it"], false), /post-remediation report/);
  assert.deepEqual(selectUnhandledAuditRecommendations(["Restrict SSH access", "Add tests"], ["restrict ssh access"]), ["Add tests"]);
});

test("new-task handoff follow-up keeps post-completion work in the exact thread", () => {
  const followup = newTaskHandoffFollowup("Phase 3.25 pending tasks:\n- Implement RecoveryPipeline\n- Run certification");
  assert.match(followup, /^\[cline-console:same-thread-handoff\]/);
  assert.match(followup, /Do not start or spawn a new task/);
  assert.match(followup, /exact same Cline thread/);
  assert.match(followup, /Phase 3\.25 pending tasks/);
  assert.match(followup, /Implement RecoveryPipeline/);
  assert.match(followup, /final task report/);
});

test("new-task handoff semantic keys coalesce formatting-only repeats per session", () => {
  assert.equal(newTaskHandoffKey("session", " Continue  remaining\nwork "), newTaskHandoffKey("session", "continue remaining work"));
  assert.notEqual(newTaskHandoffKey("session", "continue remaining work"), newTaskHandoffKey("other", "continue remaining work"));
  assert.notEqual(newTaskHandoffKey("session", "continue remaining work"), newTaskHandoffKey("session", "different work"));
});

test("new-task handoff circuit breaker compacts once and then suppresses repeats", () => {
  assert.equal(newTaskHandoffPolicy(1, false), "continue");
  assert.equal(newTaskHandoffPolicy(2, false), "continue");
  assert.equal(newTaskHandoffPolicy(3, false), "compact");
  assert.equal(newTaskHandoffPolicy(39, false), "compact");
  assert.equal(newTaskHandoffPolicy(40, true), "suppress");
});

test("reflective completion requests a durable honest report in the same task", () => {
  const followup = reflectiveCompletionFollowup("queue-id");
  assert.match(followup, /difficulties, obstacles, blockers/);
  assert.match(followup, /resolved problems from unresolved risks/);
  assert.match(followup, /\.cline-console\/reflections\/queue-id\.md/);
  assert.match(followup, /history database/);
  assert.match(followup, /without spawning a new task/);
});

test("scope violation correction stays in-thread and preserves unrelated changes", () => {
  const followup = scopeViolationFollowup("/repo/src/agent", ["/repo/docs/outside.md"]);
  assert.match(followup, /restricted to \/repo\/src\/agent/);
  assert.match(followup, /\/repo\/docs\/outside\.md/);
  assert.match(followup, /same task/);
  assert.match(followup, /preserve unrelated user changes/);
});

function adapterWithStatus(task: "active" | "none", state: "running" | "unknown"): ClineAdapter {
  return {
    newTask: async () => ({ taskStarted: true }), sendMessage: async () => {}, interruptTask: async () => {}, cancelTask: async () => {}, detect: async () => true,
    getVersion: async () => "test", getCapabilities: async () => ({ newTask: true, followup: true, cancel: true, taskStatus: true, taskId: true, directApi: true, commandApi: true, webviewBridge: false }),
    getStatus: async () => ({ connected: true, task, state })
  };
}

test("queue ownership is durable and fails closed for unrelated Cline sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ownership-")), file = path.join(root, "queue.json");
  const queue = new TaskQueue(file, "/repo", adapterWithStatus("none", "unknown"), logger, undefined, { ...DEFAULT_TASK_SCANNER_OPTIONS, enabled: false, interTaskDelayMs: 0 });
  await queue.start();
  assert.equal(queue.ownsSession("manual-session"), false);
  await queue.registerOwnedSession("console-session");
  assert.equal(queue.ownsSession("console-session"), true);
  await queue.stop();
  const restored = new TaskQueue(file, "/repo", adapterWithStatus("none", "unknown"), logger, undefined, { ...DEFAULT_TASK_SCANNER_OPTIONS, enabled: false, interTaskDelayMs: 0 });
  await restored.start();
  assert.equal(restored.ownsSession("console-session"), true);
  assert.equal(restored.ownsSession("manual-session"), false);
  await restored.stop();
  await fs.rm(root, { recursive: true });
});

test("model conflict pauses the queue without advancing its running head", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-model-conflict-")), file = path.join(root, "queue.json");
  const resumed: string[] = [], messages: string[] = [];
  await fs.writeFile(file, JSON.stringify({
    version: 1, workspace: "/repo", paused: true, timingVersion: 4, items: [
      { id: "head", sourcePath: "/tasks/head", prompt: "head", state: "running", queuedAt: "2026-10-06T09:00:00Z", dispatchedAt: "2026-10-06T09:01:00Z", activeSince: "2026-10-06T09:01:00Z", sessionId: "owned-session" },
      { id: "next", sourcePath: "/tasks/next", prompt: "next", state: "queued", queuedAt: "2026-10-06T09:02:00Z" }
    ]
  }));
  const adapter: ClineAdapter = {
    ...adapterWithStatus("active", "running"),
    resumeTask: async sessionId => { resumed.push(sessionId); return { taskStarted: true, taskId: sessionId }; },
    sendMessage: async message => { messages.push(message); }
  };
  const queue = new TaskQueue(file, "/repo", adapter, logger, undefined, { ...DEFAULT_TASK_SCANNER_OPTIONS, enabled: false });
  await queue.start();
  await queue.pauseForModelConflict("owned-session", "/competitor", "127.0.0.1:1234/model");
  const status = queue.getStatus();
  assert.equal(status.paused, true);
  assert.equal(status.items.find(item => item.id === "head")?.state, "interrupted");
  assert.equal(status.items.find(item => item.id === "head")?.activeSince, undefined);
  assert.equal(status.items.find(item => item.id === "next")?.state, "queued");
  assert.deepEqual(queue.modelConflict(), {
    sessionId: "owned-session", winnerWorkspace: "/competitor", modelIdentity: "127.0.0.1:1234/model",
    interruptedAt: queue.modelConflict()?.interruptedAt
  });
  assert.deepEqual(await queue.resumeAfterModelConflict("owned-session", "127.0.0.1:1234/model"), { resumed: true, queueLength: 2 });
  assert.deepEqual(resumed, ["owned-session"]);
  assert.match(messages[0], /Continue the current task from where it was interrupted/);
  assert.equal(queue.modelConflict(), undefined);
  assert.equal(queue.getStatus().paused, false);
  await queue.stop();
  await fs.rm(root, { recursive: true });
});

test("independent workspace queues dispatch concurrently", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-parallel-queues-"));
  const workspaces = [path.join(root, "one"), path.join(root, "two")];
  const storage = path.join(root, "cline-storage");
  await Promise.all([...workspaces.map(workspace => fs.mkdir(workspace)), fs.mkdir(path.join(storage, "state"), { recursive: true })]);
  const previousStorage = process.env.CLINE_VSCODE_STORAGE_DIR;
  process.env.CLINE_VSCODE_STORAGE_DIR = storage;
  const dispatched: string[] = [];
  const makeAdapter = (workspace: string): ClineAdapter => ({
    ...adapterWithStatus("none", "unknown"),
    newTask: async () => { dispatched.push(workspace); return { taskStarted: true }; }
  });
  const queues = workspaces.map((workspace, index) => new TaskQueue(
    path.join(root, `queue-${index}.json`), workspace, makeAdapter(workspace), logger, undefined,
    { ...DEFAULT_TASK_SCANNER_OPTIONS, enabled: false, interTaskDelayMs: 0, terminalStabilityMs: 0 }
  ));
  try {
    await Promise.all(queues.map(queue => queue.start()));
    await Promise.all(queues.map((queue, index) => queue.enqueue([{ sourcePath: `/tasks/${index}`, prompt: `parallel-${index}` }])));
    const deadline = Date.now() + 2_000;
    while (dispatched.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(new Set(dispatched), new Set(workspaces));
  } finally {
    if (previousStorage === undefined) delete process.env.CLINE_VSCODE_STORAGE_DIR;
    else process.env.CLINE_VSCODE_STORAGE_DIR = previousStorage;
    await Promise.all(queues.map(queue => queue.stop()));
    await fs.rm(root, { recursive: true });
  }
});

test("queue formatter displays active items without prompt bodies", () => {
  const output = formatQueue({
    workspace: "/repo", paused: false, queueLength: 2, running: 1, queued: 1, completed: 3, failed: 1,
    items: [
      { position: 1, id: "one", kind: "task", state: "running", title: "# Phase 1", sourcePath: "/tasks/1.md", queuedAt: "2026-08-10T00:00:00Z" },
      { position: 2, id: "two", kind: "message", state: "queued", title: "Run tests", sourcePath: "<inline-or-stdin>", queuedAt: "2026-08-10T00:01:00Z" }
    ]
  });
  assert.match(output, /Queue length: 2 \(1 running, 0 interrupted, 1 queued\)/);
  assert.match(output, /Pos\s+Type\s+State\s+Tokens\s+Title\s+Source\n-+\s+-+\s+-+\s+-+\s+-+\s+-+/);
  assert.match(output, /1\s+task\s+running\s+--\s+# Phase 1\s+\/tasks\/1\.md/);
  assert.match(output, /2\s+message\s+queued\s+--\s+Run tests/);
});

test("queue status exposes YOLO recovery so a successful scanner action is visible", () => {
  const status = buildQueueStatus("/repo", [{
    id: "task", sourcePath: "/repo/8.16.md", prompt: "# Task 8.16", state: "running",
    queuedAt: "2026-10-01T04:00:00.000Z", lastYoloRestartMarker: "session:1790829133868"
  }]);
  assert.equal(status.items[0].yoloRestartCount, 1);
  assert.equal(status.items[0].lastYoloRestartAt, "2026-10-01T04:32:13.868Z");
  assert.match(formatQueue(status, false), /YOLO recovery: 1 restart\(s\) requested/);
});

test("queue display marks an owned persisted item waiting while Cline is between same-thread messages", () => {
  const status = reconcileQueueStatus({
    workspace: "/repo", paused: false, queueLength: 2, running: 1, queued: 1, completed: 0, failed: 0,
    items: [
      { position: 1, id: "one", kind: "task", state: "running", title: "Interrupted", sourcePath: "/tasks/one", queuedAt: "before" },
      { position: 2, id: "two", kind: "task", state: "queued", title: "Next", sourcePath: "/tasks/two", queuedAt: "before" }
    ]
  }, true, { status: "waiting" });
  assert.equal(status.running, 0);
  assert.equal(status.interrupted, 0);
  assert.equal(status.items[0].state, "waiting");
  assert.match(formatQueue(status, false, true), /Processing: waiting/);
  assert.match(formatQueue(status, false, true), /0 running, 0 interrupted, 1 queued/);
});

test("queue display keeps running only while Cline reports live execution", () => {
  const base = {
    workspace: "/repo", paused: false, queueLength: 1, running: 1, queued: 0, completed: 0, failed: 0,
    items: [{ position: 1, id: "one", kind: "task" as const, state: "running" as const, title: "Live", sourcePath: "/tasks/one", queuedAt: "before" }]
  };
  assert.equal(reconcileQueueStatus(base, true, { status: "running" }).items[0].state, "running");
  assert.equal(reconcileQueueStatus(base, true, { status: "idle" }).items[0].state, "waiting");
  assert.equal(reconcileQueueStatus(base, true, { status: "completed" }).items[0].state, "waiting");
  assert.equal(reconcileQueueStatus(base, false).items[0].state, "interrupted");
});

test("queue removal accepts terminal reconciled activity but protects live and resumable tasks", () => {
  assert.equal(terminalQueueRemovalAllowed({ active: false, sessionId: "owned", status: "failed" }), true);
  assert.equal(terminalQueueRemovalAllowed({ active: false, sessionId: "owned", status: "completed" }), true);
  assert.equal(terminalQueueRemovalAllowed({ active: false, sessionId: "owned", status: "idle" }), true);
  assert.equal(terminalQueueRemovalAllowed({ active: true, sessionId: "owned", status: "running" }), false);
  assert.equal(terminalQueueRemovalAllowed({ active: true, sessionId: "owned", status: "waiting" }), false);
  assert.equal(terminalQueueRemovalAllowed(undefined), false);
});

test("task timer pauses when Cline exits execution and resumes for same-thread follow-ups", () => {
  assert.equal(taskTimerShouldRun("running", false), true);
  assert.equal(taskTimerShouldRun("completed", true), false);
  assert.equal(taskTimerShouldRun("completed", false), false);
  assert.equal(taskTimerShouldRun("waiting", true), false);
  assert.equal(taskTimerShouldRun("waiting", false), false);
});

test("task timer checkpoints active time so a companion crash loses at most one poll interval", () => {
  const item: { activeMs?: number; activeSince?: string } = { activeMs: 1_000, activeSince: "2026-09-28T10:00:00.000Z" };
  checkpointTaskTimer(item, "running", false, Date.parse("2026-09-28T10:00:05.000Z"));
  assert.equal(item.activeMs, 6_000);
  assert.equal(item.activeSince, "2026-09-28T10:00:05.000Z");
  checkpointTaskTimer(item, "completed", true, Date.parse("2026-09-28T10:00:07.000Z"));
  assert.equal(item.activeMs, 8_000);
  assert.equal(item.activeSince, undefined);
});

test("restart recovery finalizes only the exact completed owned session", () => {
  assert.equal(restartRecoveryDisposition("one", { sessionId: "one", status: "completed" }), "complete");
  assert.equal(restartRecoveryDisposition("one", { sessionId: "one", status: "running" }), "resume");
  assert.equal(restartRecoveryDisposition("one", { sessionId: "one", status: "waiting" }), "resume");
  assert.equal(restartRecoveryDisposition("one", { sessionId: "one", status: "stale" }), "resume");
  assert.equal(restartRecoveryDisposition("one", { sessionId: "one", status: "idle" }), "preserve");
  assert.equal(restartRecoveryDisposition("one", { sessionId: "two", status: "completed" }), "preserve");
  assert.equal(restartRecoveryDisposition(undefined, { sessionId: "one", status: "completed" }), "preserve");
});

test("restart recovery resumes an exact interrupted session only after stable inactivity", () => {
  const unchanged = { sessionId: "one", status: "running", observedAt: "before-reload" };
  assert.equal(restartRecoveryContinuationRequired("one", unchanged, unchanged), true);
  assert.equal(restartRecoveryContinuationRequired("one", unchanged, { ...unchanged, observedAt: "new activity" }), false);
  assert.equal(restartRecoveryContinuationRequired("one", unchanged, { ...unchanged, status: "completed" }), false);
  assert.equal(restartRecoveryContinuationRequired("one", unchanged, { ...unchanged, sessionId: "other" }), false);
});

test("restart recovery remembers a reconciled terminal session without duplicates", () => {
  assert.deepEqual(rememberIgnoredSession(["older", "done"], "done"), ["older", "done"]);
  assert.deepEqual(rememberIgnoredSession(undefined, "done"), ["done"]);
});

test("DONE override remains visible as a closed queue record", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-closed-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "closed", kind: "task", sourcePath: "/tasks/closed", prompt: "Closed task", state: "completed", userConfirmedCompletion: true, queuedAt: "before", finishedAt: "now" }
  ] }));
  assert.equal((await readQueueStatusFile(file, "/repo")).items[0].state, "closed");
  assert.match(formatQueue(await readQueueStatusFile(file, "/repo"), false), /closed\s+--\s+Closed task/);
  await fs.rm(root, { recursive: true });
});

test("queued tasks wait 15 seconds after the previous task finishes", () => {
  const now = Date.parse("2026-08-10T12:00:10.000Z");
  assert.equal(remainingTaskDispatchDelay([{ kind: "task", state: "completed", finishedAt: "2026-08-10T12:00:00.000Z" }], now), 5_000);
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

test("persisted timing baseline excludes completed tasks from before the reset", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-timing-reset-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", timingVersion: 3, timingResetAt: "2026-09-28T12:00:00.000Z", items: [
    { id: "old", sourcePath: "/tasks/old.md", prompt: "Old", state: "completed", queuedAt: "before", dispatchedAt: "2026-09-28T11:58:00.000Z", finishedAt: "2026-09-28T11:59:00.000Z", activeMs: 60_000 },
    { id: "crossing", sourcePath: "/tasks/crossing.md", prompt: "Crossing", state: "completed", queuedAt: "before", dispatchedAt: "2026-09-28T11:59:00.000Z", finishedAt: "2026-09-28T12:01:00.000Z", activeMs: 30_000 },
    { id: "new", sourcePath: "/tasks/new.md", prompt: "New", state: "completed", queuedAt: "after", dispatchedAt: "2026-09-28T12:00:01.000Z", finishedAt: "2026-09-28T12:02:01.000Z", activeMs: 120_000 }
  ] }));
  const status = await readQueueStatusFile(file, "/repo");
  assert.deepEqual(status.timing, {
    sampleCount: 1, averageMs: 120_000, estimateMs: 120_000, lastMs: 120_000,
    medianMs: 120_000, p25Ms: 120_000, p75Ms: 120_000, p90Ms: 120_000,
    trimmedMeanMs: 120_000, ewmaMs: 120_000, minMs: 120_000, maxMs: 120_000,
    standardDeviationMs: 0, coefficientVariation: 0, tasksPerHour: 30,
    recentMedianMs: 120_000, spreadRatio: 0, confidence: "low"
  });
  await fs.rm(root, { recursive: true });
});

test("task timing model resists an extreme duration and reports its confidence", () => {
  const minute = 60_000;
  const timing = calculateTaskTiming([10, 11, 12, 13, 14, 300].map(value => value * minute));
  assert.equal(timing.sampleCount, 6);
  assert.equal(timing.medianMs, 12.5 * minute);
  assert.equal(timing.trimmedMeanMs, 12.5 * minute);
  assert.equal(timing.averageMs, 60 * minute);
  assert.ok((timing.ewmaMs ?? Infinity) < 20 * minute);
  assert.ok((timing.estimateMs ?? Infinity) < 20 * minute);
  assert.equal(timing.minMs, 10 * minute);
  assert.equal(timing.maxMs, 300 * minute);
  assert.ok((timing.coefficientVariation ?? 0) > 1);
  assert.ok((timing.tasksPerHour ?? 0) > 0);
  assert.equal(timing.recentMedianMs, 13 * minute);
  assert.equal(timing.trend, "slower");
  assert.equal(timing.confidence, "medium");
});

test("a task removed by the user is displayed as interrupted and never becomes a timing sample", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-interrupted-status-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", items: [
    { id: "interrupted", sourcePath: "/tasks/one.md", prompt: "Task", state: "running", queuedAt: "before", dispatchedAt: "2026-09-28T10:00:00.000Z", activeMs: 60_000, error: "Cline task was interrupted or removed; queue paused without advancing." }
  ] }));
  const status = await readQueueStatusFile(file, "/repo");
  assert.equal(status.items[0].state, "interrupted");
  assert.equal(status.timing?.sampleCount, 0);
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

test("unfinished task enqueue deduplicates retained Cline history IDs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-unfinished-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "existing", sourcePath: "cline-history:one", prompt: "First", state: "completed", queuedAt: "before" }
  ] }));
  const queue = new TaskQueue(file, "/repo", {} as ClineAdapter, logger);
  try {
    await queue.start();
    const result = await queue.enqueueUnfinished([
      { sourcePath: "cline-history:one", prompt: "First" },
      { sourcePath: "cline-history:two", prompt: "Second" }
    ]);
    assert.deepEqual(result, { queued: 1, skippedExisting: 1, queueLength: 1 });
    assert.equal(queue.getStatus().items[0].sourcePath, "cline-history:two");
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
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
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace, paused: true, timingVersion: 4, timingResetAt: "2026-08-01T00:00:00Z", tokenUsageBySession: {
    old: { input: 10, output: 5, total: 15, cacheReads: 0, cacheWrites: 0, sessions: 1 }
  }, items: [
    { id: "stale", sourcePath: "/tasks/stale.md", prompt: "Stale task", state: "running", queuedAt: "before", dispatchedAt: "2026-08-10T00:00:00Z" },
    { id: "waiting", sourcePath: "/tasks/waiting.md", prompt: "Waiting task", state: "queued", queuedAt: "now" }
  ] }));
  const queue = new TaskQueue(file, workspace, adapterWithStatus("none", "unknown"), logger);
  try {
    await queue.start();
    assert.deepEqual(await queue.clear(), { cleared: 2, clearedWaiting: 1, clearedStaleRunning: 1, queueLength: 0, runningPreserved: false, historyDeleted: 0 });
    assert.equal(queue.getStatus().queueLength, 0);
    assert.equal(queue.getStatus().paused, false, "clear must not leave future queue items silently paused");
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { paused?: boolean; timingResetAt?: string; tokenUsageBySession?: Record<string, unknown> };
    assert.equal(persisted.paused, false);
    assert.deepEqual(persisted.tokenUsageBySession, {});
    assert.ok(Date.parse(persisted.timingResetAt ?? "") > Date.parse("2026-08-01T00:00:00Z"));
    assert.equal(queue.getRetainedTokenUsage().size, 0);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("queue --clear removes only terminal records and preserves active work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-clean-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "closed", sourcePath: "/tasks/closed.md", prompt: "Closed", state: "completed", userConfirmedCompletion: true, queuedAt: "before", finishedAt: "now" },
    { id: "failed", sourcePath: "/tasks/failed.md", prompt: "Failed", state: "failed", queuedAt: "before", finishedAt: "now" },
    { id: "skipped", sourcePath: "/tasks/skipped.md", prompt: "Skipped", state: "skipped", queuedAt: "before", finishedAt: "now" },
    { id: "active", sourcePath: "/tasks/active.md", prompt: "Active", state: "running", queuedAt: "before", dispatchedAt: "now" },
    { id: "waiting", sourcePath: "/tasks/waiting.md", prompt: "Waiting", state: "queued", queuedAt: "now" }
  ] }));
  const queue = new TaskQueue(file, "/repo", adapterWithStatus("active", "running"), logger);
  try {
    await queue.start();
    assert.deepEqual(await queue.cleanFinished(), { cleared: 3, completed: 1, failed: 1, skipped: 1, queueLength: 2 });
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { paused?: boolean; items: Array<{ id: string; state: string }> };
    assert.equal(persisted.paused, true);
    assert.deepEqual(persisted.items.map(item => ({ id: item.id, state: item.state })), [
      { id: "active", state: "running" },
      { id: "waiting", state: "queued" }
    ]);
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

test("concurrent queue persistence is serialized and leaves no temporary files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-persist-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [] }));
  const queue = new TaskQueue(file, "/repo", adapterWithStatus("none", "unknown"), logger);
  try {
    await queue.start();
    await Promise.all(Array.from({ length: 12 }, (_, index) => queue.enqueue([{
      sourcePath: `/tasks/${index}.md`, prompt: `Task ${index}`
    }])));
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { items: Array<{ sourcePath: string }> };
    assert.equal(persisted.items.length, 12);
    assert.deepEqual((await fs.readdir(root)).filter(name => name.endsWith(".tmp")), []);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("enqueue context reports an active item without building full queue telemetry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-enqueue-context-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "current", kind: "task", sourcePath: "/current.md", prompt: "Current", state: "running", queuedAt: "2026-10-03T00:00:00Z", sessionId: "owned" },
    ...Array.from({ length: 250 }, (_, index) => ({ id: `queued-${index}`, kind: "task", sourcePath: `/queued-${index}.md`, prompt: `Queued ${index}`, state: "queued", queuedAt: "2026-10-03T00:00:00Z" }))
  ] }));
  const queue = new TaskQueue(file, "/repo", {} as ClineAdapter, logger);
  try {
    await queue.start();
    assert.deepEqual(queue.getEnqueueContext(), { active: true, sessionId: "owned", status: "running" });
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("DONE marks only the running queue task user-confirmed complete", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-done-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "active", sourcePath: "/tasks/active.md", prompt: "Active task", state: "running", queuedAt: "before", dispatchedAt: "now" },
    { id: "waiting", sourcePath: "/tasks/waiting.md", prompt: "Waiting task", state: "queued", queuedAt: "now" }
  ] }));
  const queue = new TaskQueue(file, "/repo", adapterWithStatus("active", "running"), logger);
  try {
    await queue.start();
    assert.deepEqual(await queue.confirmCompletion(), { completed: true, id: "active", title: "Active task", queueLength: 1 });
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { items: Array<{ id: string; state: string; userConfirmedCompletion?: boolean }> };
    assert.deepEqual(persisted.items.map(item => ({ id: item.id, state: item.state, confirmed: item.userConfirmedCompletion === true })), [
      { id: "active", state: "completed", confirmed: true },
      { id: "waiting", state: "queued", confirmed: false }
    ]);
    await assert.rejects(queue.confirmCompletion(), /No running queue task/);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("queue --next records an explicit skip and releases the next item", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-next-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "active", kind: "message", sourcePath: "message:active", prompt: "Active message", targetSessionId: "owned", state: "running", queuedAt: "before", dispatchedAt: "now" },
    { id: "waiting", sourcePath: "/tasks/waiting.md", prompt: "Waiting task", state: "queued", queuedAt: "now" }
  ] }));
  const queue = new TaskQueue(file, "/repo", adapterWithStatus("none", "unknown"), logger);
  try {
    await queue.start();
    assert.deepEqual(await queue.advanceToNext(), {
      advanced: true,
      skipped: { id: "active", title: "Active message" },
      queueLength: 1
    });
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { paused?: boolean; items: Array<{ id: string; state: string; error?: string }> };
    assert.equal(persisted.paused, false);
    assert.deepEqual(persisted.items.map(item => ({ id: item.id, state: item.state })), [
      { id: "active", state: "skipped" },
      { id: "waiting", state: "queued" }
    ]);
    assert.match(persisted.items[0].error ?? "", /queue --next/);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("DONE on the final item closes the lifecycle and resets live counters", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-done-final-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, timingVersion: 4, timingResetAt: "2026-08-01T00:00:00Z", tokenUsageBySession: {
    owned: { input: 10, output: 5, total: 15, cacheReads: 0, cacheWrites: 0, sessions: 1 }
  }, items: [
    { id: "active", sourcePath: "/tasks/active.md", prompt: "Active task", state: "running", queuedAt: "before", dispatchedAt: "2026-10-03T00:00:00Z", activeMs: 120_000, sessionId: "owned" }
  ] }));
  const queue = new TaskQueue(file, "/repo", adapterWithStatus("active", "running"), logger);
  try {
    await queue.start();
    assert.deepEqual(await queue.confirmCompletion(), { completed: true, id: "active", title: "Active task", queueLength: 0 });
    const status = queue.getStatus();
    assert.equal(status.queueLength, 0);
    assert.equal(status.completed, 0);
    assert.equal(status.failed, 0);
    assert.equal(status.timing?.sampleCount, 0);
    assert.deepEqual(status.items, []);
    assert.equal(queue.getRetainedTokenUsage().size, 0);
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { items: Array<{ id: string; state: string }>; tokenUsageBySession?: Record<string, unknown> };
    assert.deepEqual(persisted.items.map(item => ({ id: item.id, state: item.state })), [{ id: "active", state: "completed" }]);
    assert.deepEqual(persisted.tokenUsageBySession, {});
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

test("unfinished history discovery selects explicit remaining-work reports oldest first", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-history-unfinished-"));
  await fs.mkdir(path.join(root, "state"), { recursive: true });
  for (const id of ["one", "done", "partial", "resumed", "progress", "two", "other"]) await fs.mkdir(path.join(root, "tasks", id), { recursive: true });
  await fs.writeFile(path.join(root, "state", "taskHistory.json"), JSON.stringify([
    { id: "one", cwdOnTaskInitialization: "/repo", task: "First unfinished" },
    { id: "done", cwdOnTaskInitialization: "/repo", task: "Completed" },
    { id: "partial", cwdOnTaskInitialization: "/repo", task: "Partial completion" },
    { id: "resumed", cwdOnTaskInitialization: "/repo", task: "Currently resumed" },
    { id: "progress", cwdOnTaskInitialization: "/repo", task: "Incomplete progress" },
    { id: "two", cwdOnTaskInitialization: "/repo", task: "Second unfinished" },
    { id: "other", cwdOnTaskInitialization: "/other", task: "Wrong workspace" }
  ]));
  await fs.writeFile(path.join(root, "tasks", "one", "ui_messages.json"), JSON.stringify([{ ask: "resume_task" }]));
  await fs.writeFile(path.join(root, "tasks", "done", "ui_messages.json"), JSON.stringify([
    { say: "completion_result", text: "All requested work is complete and validated." },
    { ask: "completion_result" }
  ]));
  await fs.writeFile(path.join(root, "tasks", "partial", "ui_messages.json"), JSON.stringify([
    { say: "completion_result", text: "### Remaining Stages (Future Work):\n- Implement stages 4-8" },
    { ask: "completion_result" }
  ]));
  await fs.writeFile(path.join(root, "tasks", "resumed", "ui_messages.json"), JSON.stringify([
    { say: "completion_result", text: "## Remaining work\n- Finish validation" },
    { ask: "completion_result" },
    { say: "api_req_started" }
  ]));
  await fs.writeFile(path.join(root, "tasks", "progress", "ui_messages.json"), JSON.stringify([
    { say: "task_progress", text: "- [x] Analyze\n- [ ] Implement\n- [ ] Validate" },
    { say: "completion_result", text: "Work completed." },
    { ask: "completion_result" }
  ]));
  await fs.writeFile(path.join(root, "tasks", "two", "ui_messages.json"), JSON.stringify([{ ask: "resume_task" }]));
  await fs.writeFile(path.join(root, "tasks", "other", "ui_messages.json"), JSON.stringify([{ ask: "resume_task" }]));
  assert.deepEqual(await getLegacyUnfinishedWorkspaceTasks("/repo", root), [
    { sessionId: "partial", prompt: "Partial completion", sourcePath: "cline-history:partial" },
    { sessionId: "resumed", prompt: "Currently resumed", sourcePath: "cline-history:resumed" },
    { sessionId: "progress", prompt: "Incomplete progress", sourcePath: "cline-history:progress" }
  ]);
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
    sendMessage: async () => {}, interruptTask: async () => {}, cancelTask: async () => {}, detect: async () => true,
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

test("queue trim removes a waiting suffix atomically and preserves the active prefix", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-trim-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "running", kind: "task", sourcePath: "/tasks/one.md", prompt: "One", state: "running", queuedAt: "now", sessionId: "owned" },
    { id: "keep", kind: "task", sourcePath: "/tasks/two.md", prompt: "Two", state: "queued", queuedAt: "now" },
    { id: "drop-1", kind: "task", sourcePath: "/tasks/three.md", prompt: "Three", state: "queued", queuedAt: "now" },
    { id: "drop-2", kind: "task", sourcePath: "/tasks/four.md", prompt: "Four", state: "queued", queuedAt: "now" }
  ] }));
  const queue = new TaskQueue(file, "/repo", adapterWithStatus("none", "unknown"), logger);
  try {
    await queue.start();
    assert.deepEqual(await queue.trim(2), { trimmed: 2, kept: 2, queueLength: 2 });
    assert.deepEqual(queue.getStatus().items.filter(item => item.state === "running" || item.state === "queued").map(item => item.id), ["running", "keep"]);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("fresh add overrides an interrupted head and inserts replacements before waiting work", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-fresh-interrupted-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "interrupted", kind: "task", sourcePath: "/tasks/old.md", prompt: "Old", state: "running", queuedAt: "before", sessionId: "old-session" },
    { id: "waiting", kind: "task", sourcePath: "/tasks/later.md", prompt: "Later", state: "queued", queuedAt: "before" }
  ] }));
  const adapter = {
    newTask: async () => ({ taskStarted: true }), sendMessage: async () => {}, interruptTask: async () => {}, cancelTask: async () => {}, detect: async () => true,
    getVersion: async () => "test", getCapabilities: async () => ({ newTask: true, followup: true, cancel: true, taskStatus: true, taskId: true, directApi: true, commandApi: true, webviewBridge: false }),
    getStatus: async () => ({ connected: true, task: "none" as const, state: "unknown" as const })
  } satisfies ClineAdapter;
  const queue = new TaskQueue(file, "/repo", adapter, logger);
  try {
    await queue.start();
    // Test with freshOnInterrupted (the -f flag behavior)
    let result = await queue.enqueue([{ sourcePath: "/tasks/fresh.md", prompt: "Fresh" }], false, true);
    assert.equal(result.interruptedOverridden, true);
    let persisted = JSON.parse(await fs.readFile(file, "utf8"));
    // Fresh override uses the original message format
    assert.match(persisted.items[0].error || "", /Interrupted queue task explicitly overridden by queue add/);
    assert.equal(persisted.items[1].resumeSessionId, undefined);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("force enqueue overrides an interrupted head and allows duplicates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-force-interrupted-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "interrupted2", kind: "task", sourcePath: "/tasks/old.md", prompt: "Old task content", state: "running", queuedAt: "before", sessionId: "old-session" },
    { id: "waiting2", kind: "task", sourcePath: "/tasks/later.md", prompt: "Later", state: "queued", queuedAt: "before" }
  ] }));
  const adapter = {
    newTask: async () => ({ taskStarted: true }), sendMessage: async () => {}, interruptTask: async () => {}, cancelTask: async () => {}, detect: async () => true,
    getVersion: async () => "test", getCapabilities: async () => ({ newTask: true, followup: true, cancel: true, taskStatus: true, taskId: true, directApi: true, commandApi: true, webviewBridge: false }),
    getStatus: async () => ({ connected: true, task: "none" as const, state: "unknown" as const })
  } satisfies ClineAdapter;
  const queue = new TaskQueue(file, "/repo", adapter, logger);
  try {
    await queue.start();
    // Test with force (the --force flag behavior)
    let result = await queue.enqueue([{ sourcePath: "/tasks/fresh2.md", prompt: "Fresh" }], false, false, true);
    assert.equal(result.interruptedOverridden, true);
    let persisted = JSON.parse(await fs.readFile(file, "utf8"));
    // Force override uses the new message format with analysis
    assert.match(persisted.items[0].error || "", /Interrupted queue task explicitly overridden by queue add --force/);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("persisted queue resumes after restart idle stability without overriding pause", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-restart-")), file = path.join(root, "queue.json"), workspace = path.join(root, "workspace"), storage = path.join(root, "cline-storage");
  await fs.mkdir(workspace);
  await fs.mkdir(path.join(storage, "state"), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace, items: [
    { id: "one", kind: "task", sourcePath: "/tasks/one.md", prompt: "Task one", state: "queued", queuedAt: "before" }
  ] }));
  const previousStorage = process.env.CLINE_VSCODE_STORAGE_DIR;
  process.env.CLINE_VSCODE_STORAGE_DIR = storage;
  const dispatched: string[] = [];
  const adapter = {
    newTask: async (prompt: string) => { dispatched.push(prompt); return { taskStarted: true }; },
    sendMessage: async () => {}, interruptTask: async () => {}, cancelTask: async () => {}, detect: async () => true,
    getVersion: async () => "test", getCapabilities: async () => ({ newTask: true, followup: true, cancel: true, taskStatus: true, taskId: true, directApi: true, commandApi: true, webviewBridge: false }),
    getStatus: async () => ({ connected: true, task: "none" as const, state: "unknown" as const })
  } satisfies ClineAdapter;
  const scanner = { ...DEFAULT_TASK_SCANNER_OPTIONS, interTaskDelayMs: 30 };
  const queue = new TaskQueue(file, workspace, adapter, logger, undefined, scanner);
  try {
    await queue.start();
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.deepEqual(dispatched, []);
    const deadline = Date.now() + 2_000;
    while (!dispatched.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(dispatched, ["Task one"]);
  } finally {
    if (previousStorage === undefined) delete process.env.CLINE_VSCODE_STORAGE_DIR;
    else process.env.CLINE_VSCODE_STORAGE_DIR = previousStorage;
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("restart recovery delivers a failure continuation that was interrupted by VS Code exit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-recovery-")), file = path.join(root, "queue.json"), workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace, items: [
    {
      id: "interrupted", kind: "task", sourcePath: "/tasks/interrupted.md", prompt: "Interrupted task", state: "running",
      queuedAt: "before", dispatchedAt: "before", sessionId: "cline-session", lastFailureMarker: "failure-marker", error: "Too many consecutive mistakes"
    }
  ] }));
  const selected: string[] = [], messages: string[] = [];
  const adapter = {
    newTask: async () => ({ taskStarted: true }),
    resumeTask: async (sessionId: string) => { selected.push(sessionId); return { taskStarted: true }; },
    sendMessage: async (message: string) => { messages.push(message); }, interruptTask: async () => {}, cancelTask: async () => {}, detect: async () => true,
    getVersion: async () => "test", getCapabilities: async () => ({ newTask: true, followup: true, cancel: true, taskStatus: true, taskId: true, directApi: true, commandApi: true, webviewBridge: false }),
    getStatus: async () => ({ connected: true, task: "none" as const, state: "unknown" as const })
  } satisfies ClineAdapter;
  const queue = new TaskQueue(file, workspace, adapter, logger, undefined, { ...DEFAULT_TASK_SCANNER_OPTIONS, interTaskDelayMs: 10 });
  try {
    await queue.start();
    const deadline = Date.now() + 3_000;
    let persisted: { recoveryProtocolVersion?: number; items: Array<{ pendingRecoveryContinuation?: unknown; error?: string }> } | undefined;
    while (Date.now() < deadline) {
      persisted = JSON.parse(await fs.readFile(file, "utf8")) as typeof persisted;
      if (messages.length && persisted?.items[0].pendingRecoveryContinuation === undefined) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(selected, ["cline-session"]);
    assert.deepEqual(messages, ["continue"]);
    assert.equal(persisted?.recoveryProtocolVersion, 1);
    assert.equal(persisted?.items[0].pendingRecoveryContinuation, undefined);
    assert.equal(persisted?.items[0].error, undefined);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("per-task reflective override survives queue persistence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-reflective-queue-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [] }));
  const queue = new TaskQueue(file, "/repo", {} as ClineAdapter, logger);
  try {
    await queue.start();
    await queue.enqueue([{ sourcePath: "/tasks/reflect.md", prompt: "Reflect", reflective: true }]);
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { items: Array<{ reflective?: boolean }> };
    assert.equal(persisted.items[0].reflective, true);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("task reload atomically moves the running queue item to the successor session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-reload-adoption-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, ownedSessionIds: ["old"], items: [
    { id: "running", sourcePath: "/tasks/one.md", prompt: "Task", state: "running", queuedAt: "before", dispatchedAt: "before", sessionId: "old", lastFailureMarker: "old:failure", error: "old failure" }
  ] }));
  const queue = new TaskQueue(file, "/repo", {} as ClineAdapter, logger);
  try {
    await queue.start();
    await queue.adoptReloadedSession("old", "new");
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { ownedSessionIds: string[]; items: Array<{ sessionId?: string; lastFailureMarker?: string; error?: string }> };
    assert.equal(persisted.items[0].sessionId, "new");
    assert.equal(persisted.items[0].lastFailureMarker, undefined);
    assert.equal(persisted.items[0].error, undefined);
    assert.ok(persisted.ownedSessionIds.includes("new"));
    await queue.adoptReloadedSession("new", "newer", "Task");
    const chained = JSON.parse(await fs.readFile(file, "utf8")) as { items: Array<{ sessionId?: string }> };
    assert.equal(chained.items[0].sessionId, "newer");
    await assert.rejects(() => queue.adoptReloadedSession("unrelated", "other"), /does not replace the running/);
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("queue relaunch cancels the owned running thread before starting it from scratch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-relaunch-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, ownedSessionIds: ["old"], items: [
    { id: "running", kind: "task", sourcePath: "/tasks/one.md", prompt: "Task", state: "running", queuedAt: "before", dispatchedAt: "before", sessionId: "old" }
  ] }));
  const calls: string[] = [];
  const adapter = {
    cancelTask: async () => { calls.push("cancel:old"); },
    newTask: async (prompt: string) => { calls.push(`new:${prompt}`); return { taskStarted: true, taskId: "new" }; }
  } as unknown as ClineAdapter;
  const queue = new TaskQueue(file, "/repo", adapter, logger);
  try {
    await queue.start();
    const result = await queue.relaunchCurrent();
    assert.deepEqual(calls, ["cancel:old", "new:Task"]);
    assert.equal(result.relaunched, true);
    assert.equal(result.previousSessionId, "old");
    assert.equal(result.sessionId, "new");
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as { items: Array<{ sessionId?: string }> };
    assert.equal(persisted.items[0].sessionId, "new");
  } finally {
    await queue.stop();
    await fs.rm(root, { recursive: true });
  }
});

test("queue rejects duplicate task sources unless explicitly confirmed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-duplicate-queue-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "existing", sourcePath: "/tasks/same.md", prompt: "Existing", state: "queued", queuedAt: "now" }
  ] }));
  const queue = new TaskQueue(file, "/repo", {} as ClineAdapter, logger);
  try {
    await queue.start();
    await assert.rejects(queue.enqueue([{ sourcePath: "/tasks/same.md", prompt: "Duplicate" }]), /already active or duplicated/);
    await assert.rejects(queue.enqueue([
      { sourcePath: "/tasks/new.md", prompt: "First" },
      { sourcePath: "/tasks/new.md", prompt: "Second" }
    ]), /already active or duplicated/);
    assert.equal((await queue.enqueue([{ sourcePath: "/tasks/same.md", prompt: "Confirmed" }], true)).queued, 1);
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

test("queue pop removes a waiting item by its displayed position", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-queue-pop-position-")), file = path.join(root, "queue.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, workspace: "/repo", paused: true, items: [
    { id: "running-id", sourcePath: "/tasks/running.md", prompt: "Running", state: "running", queuedAt: "now" },
    { id: "waiting-id", sourcePath: "/tasks/waiting.md", prompt: "Waiting", state: "queued", queuedAt: "now" }
  ] }));
  const queue = new TaskQueue(file, "/repo", {} as ClineAdapter, logger);
  try {
    await queue.start();
    await assert.rejects(queue.pop("1", undefined, "id"), /position 1 is currently running/);
    assert.equal((await queue.pop("2")).id, "waiting-id");
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
