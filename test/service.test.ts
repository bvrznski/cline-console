import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Logger } from "../src/common/logging";
import { ClineConsoleService, companionFailureIsRestartable, companionRecoveryReady, isSafeCodeExtensionHostCommand, modelLeaseOccupied, modelRestorationReady, nextCompanionFailure, probeService, readEnqueueContext, recoverRestartArtifacts, removeExpiredRestartArtifacts, restartLeaseActive, selectModelQueueWinner, selectOrphanedModelQueue, unexpectedlyClosedQueueWorkspaces, updatePreviousRunningSessions, YOLO_RESTART_LEASE_GRACE_MS, type ModelQueueObservation } from "../src/service/daemon";

const logger: Logger = { error() {}, info() {}, debug() {} };

test("service permits exactly one live instance", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-service-"));
  const first = new ClineConsoleService(logger, directory), second = new ClineConsoleService(logger, directory);
  await first.start();
  assert.equal(await probeService(first.socketPath), true);
  await assert.rejects(second.start(), /already running/);
  assert.equal(await probeService(first.socketPath), true);
  await first.stop();
  assert.equal(await probeService(first.socketPath), false);
  await fs.rm(directory, { recursive: true });
});

test("service shutdown is idempotent", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-service-stop-"));
  const service = new ClineConsoleService(logger, directory);
  await service.start();
  await assert.doesNotReject(Promise.all([service.stop(), service.stop()]));
  assert.equal(await probeService(service.socketPath), false);
  await fs.rm(directory, { recursive: true });
});

test("daemon restart guard accepts only a VS Code Node extension host", () => {
  assert.equal(isSafeCodeExtensionHostCommand("/usr/share/code/code --type=utility --utility-sub-type=node.mojom.NodeService"), true);
  assert.equal(isSafeCodeExtensionHostCommand("/usr/share/code/code /repo"), false);
  assert.equal(isSafeCodeExtensionHostCommand("node --type=utility --utility-sub-type=node.mojom.NodeService"), false);
});

test("unexpected-close detector selects only active queues without a companion", () => {
  const queues = [
    { workspace: "/active-offline", queueLength: 2 },
    { workspace: "/empty-offline", queueLength: 0 },
    { workspace: "/paused-offline", queueLength: 2, paused: true },
    { workspace: "/active-online", queueLength: 1 }
  ];
  assert.deepEqual(unexpectedlyClosedQueueWorkspaces(queues, [{ workspace: "/active-online" }]), ["/active-offline"]);
});

test("unresponsive companion recovery requires sustained failures and resets for a replacement PID", () => {
  assert.equal(companionFailureIsRestartable("connect EAGAIN /run/user/1000/cline-console/workspace.sock"), true);
  assert.equal(companionFailureIsRestartable("Timed out waiting for the VS Code extension."), false);
  assert.equal(companionFailureIsRestartable("connect ECONNREFUSED /tmp/workspace.sock"), false);
  const registration = { pid: 101 };
  let failure = nextCompanionFailure(undefined, registration, "connect EAGAIN", 1_000);
  for (let count = 1; count < 5; count += 1) failure = nextCompanionFailure(failure, registration, "connect EAGAIN", 2_000 + count);
  assert.equal(failure.failures, 5);
  assert.equal(companionRecoveryReady(failure, 30_999, 30_000, 5), false);
  assert.equal(companionRecoveryReady(failure, 31_000, 30_000, 5), true);

  const replacementFailure = nextCompanionFailure(failure, { pid: 202 }, "timeout", 40_000);
  assert.deepEqual(replacementFailure, { pid: 202, failures: 1, since: 40_000, lastError: "timeout" });
  assert.equal(companionRecoveryReady(replacementFailure, 80_000, 30_000, 5), false);
});

test("newly resumed workspace acquires a shared model without heartbeat ping-pong", () => {
  const first: ModelQueueObservation = { active: true, status: "running", workspace: "/one", socketPath: "/one.sock", sessionId: "one", modelIdentity: "lm/model", observedAt: "2026-10-06T10:00:00Z" };
  const second: ModelQueueObservation = { active: true, status: "running", workspace: "/two", socketPath: "/two.sock", sessionId: "two", modelIdentity: "lm/model", observedAt: "2026-10-06T10:01:00Z" };
  assert.equal(selectModelQueueWinner([first, second], { workspace: "/one", sessionId: "one" }, new Map([["/one", "one"]]))?.workspace, "/two");
  assert.equal(selectModelQueueWinner([first, second], { workspace: "/two", sessionId: "two" }, new Map([["/one", "one"], ["/two", "two"]]))?.workspace, "/two");
});

test("preempted model queue waits for the full restoration delay", () => {
  assert.equal(modelRestorationReady(undefined, 20_000, 15_000), false);
  assert.equal(modelRestorationReady(5_001, 20_000, 15_000), false);
  assert.equal(modelRestorationReady(5_000, 20_000, 15_000), true);
});

test("released model selects orphaned queue work for a clean relaunch", () => {
  const orphaned: ModelQueueObservation = { active: false, queueActive: true, orphanedQueueTask: true, status: "idle", workspace: "/gordon", socketPath: "/gordon.sock", sessionId: "stale", modelIdentity: "lm/model", observedAt: "2026-10-14T01:00:00Z" };
  const unrelated: ModelQueueObservation = { active: false, queueActive: false, status: "completed", workspace: "/rebuntu", socketPath: "/rebuntu.sock", sessionId: "done", modelIdentity: "lm/model", observedAt: "2026-10-14T01:01:00Z" };
  assert.equal(selectOrphanedModelQueue([orphaned, unrelated], "lm/model")?.workspace, "/gordon");
  assert.equal(selectOrphanedModelQueue([orphaned, unrelated], "other/model"), undefined);
});

test("completion follow-ups retain the model lease while manual Cancel releases it", () => {
  assert.equal(modelLeaseOccupied({ status: "running", queueActive: true }), true);
  assert.equal(modelLeaseOccupied({ status: "completed", queueActive: true }), true);
  assert.equal(modelLeaseOccupied({ status: "idle", queueActive: true }), true);
  assert.equal(modelLeaseOccupied({ status: "waiting", queueActive: true }), false);
  assert.equal(modelLeaseOccupied({ status: "completed", queueActive: false }), false);
});

test("YOLO respawn preserves the current model lease until recovery or timeout", () => {
  const now = Date.now();
  const protection = { sessionId: "task-1", until: now + YOLO_RESTART_LEASE_GRACE_MS };
  assert.equal(restartLeaseActive(protection, undefined, now), true);
  assert.equal(restartLeaseActive(protection, { status: "waiting" }, now), true);
  assert.equal(restartLeaseActive(protection, { status: "running" }, now), false);
  assert.equal(restartLeaseActive(protection, undefined, protection.until), false);
});

test("a missed companion poll does not fabricate a fresh task resume", () => {
  const previous = new Map([["/rebuntu", "session-1"], ["/gordon", "session-2"]]);
  const afterMiss = updatePreviousRunningSessions(previous, [{ workspace: "/gordon", status: "completed", sessionId: "session-2" }]);
  assert.equal(afterMiss.get("/rebuntu"), "session-1");
  assert.equal(afterMiss.has("/gordon"), false);
  const afterObservedStop = updatePreviousRunningSessions(afterMiss, [{ workspace: "/rebuntu", status: "waiting", sessionId: "session-1" }]);
  assert.equal(afterObservedStop.has("/rebuntu"), false);
});

test("daemon reads minimal enqueue context from a large persisted queue", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-enqueue-context-"));
  const file = path.join(directory, "queue.json");
  await fs.writeFile(file, JSON.stringify({ workspace: "/repo", items: [
    { state: "running", sessionId: "owned" },
    ...Array.from({ length: 300 }, () => ({ state: "queued" }))
  ] }));
  assert.deepEqual(await readEnqueueContext(file, "/repo"), { active: true, sessionId: "owned", status: "running", queueLength: 301 });
  await fs.rm(directory, { recursive: true });
});

test("daemon recovers abandoned claims and removes only expired legacy restart artifacts", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-restart-artifacts-"));
  const old = new Date(Date.now() - 20 * 60_000);
  const abandoned = path.join(directory, "restart-11111111-1111-1111-1111-111111111111.json.processing");
  const expired = path.join(directory, "restart-22222222-2222-2222-2222-222222222222.json");
  const fresh = path.join(directory, "restart-33333333-3333-3333-3333-333333333333.json");
  await Promise.all([fs.writeFile(abandoned, "{}"), fs.writeFile(expired, "{}"), fs.writeFile(fresh, "{}")]);
  await Promise.all([fs.utimes(abandoned, old, old), fs.utimes(expired, old, old)]);
  assert.equal(await recoverRestartArtifacts(directory), 1);
  assert.equal(await fs.stat(abandoned.slice(0, -".processing".length)).then(() => true), true);
  assert.equal(await removeExpiredRestartArtifacts(directory), 2);
  assert.equal(await fs.stat(fresh).then(() => true), true);
  await fs.rm(directory, { recursive: true });
});
