import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Logger } from "../src/common/logging";
import { IpcServer, isPollingAction, summarizeRequest, summarizeResponse } from "../src/extension/server";
import { socketPath, workspaceId } from "../src/extension/workspace_registry";
import type { ClineAdapter } from "../src/integrations/cline/types";
import { DEFAULT_IPC_REQUEST_TIMEOUT_MS, ipcRequestTimeout, QUEUE_MUTATION_TIMEOUT_MS } from "../src/ipc/protocol";

const logger: Logger = { error() {}, info() {}, debug() {} };
const adapter = {} as ClineAdapter;

test("high-frequency status polling is excluded from durable IPC history", () => {
  assert.equal(isPollingAction("queueStatus"), true);
  assert.equal(isPollingAction("status"), true);
  assert.equal(isPollingAction("enqueueTasks"), false);
});

test("queue mutations receive an extended end-to-end IPC deadline", () => {
  for (const action of ["enqueueTasks", "enqueueMessages", "replaceQueue", "clearQueue", "clearWorkspace", "popQueue", "trimQueue"] as const) {
    assert.equal(ipcRequestTimeout(action), QUEUE_MUTATION_TIMEOUT_MS, action);
  }
  assert.equal(ipcRequestTimeout("queueStatus"), DEFAULT_IPC_REQUEST_TIMEOUT_MS);
  assert.equal(ipcRequestTimeout("status"), DEFAULT_IPC_REQUEST_TIMEOUT_MS);
});

test("durable IPC summaries never duplicate prompt or queue response bodies", () => {
  const request = { protocolVersion: 1 as const, requestId: "r1", action: "enqueueTasks" as const, workspace: "/repo", payload: { tasks: [{ sourcePath: "task.md", prompt: "secret prompt" }], allowDuplicates: true } };
  assert.deepEqual(summarizeRequest(request), { requestId: "r1", action: "enqueueTasks", taskCount: 1, payloadKeys: ["allowDuplicates", "tasks"] });
  assert.deepEqual(summarizeResponse(request, { queueLength: 300, items: [{ prompt: "secret prompt" }] }), { requestId: "r1", action: "enqueueTasks", resultType: "object", queueLength: 300 });
});

test("server removes a stale socket and cleans up on stop", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-server-"));
  const workspace = path.join(root, "workspace"), runtime = path.join(root, "runtime");
  await fs.mkdir(workspace); await fs.mkdir(runtime);
  const stale = socketPath(runtime, workspaceId(await fs.realpath(workspace)));
  const old = net.createServer(); await new Promise<void>(resolve => old.listen(stale, resolve)); await new Promise<void>(resolve => old.close(() => resolve()));
  const server = new IpcServer(runtime, workspace, adapter, logger);
  await server.start(); assert.equal((await fs.lstat(stale)).isSocket(), true);
  await server.stop(); await assert.rejects(fs.lstat(stale));
  await fs.rm(root, { recursive: true });
});

test("server refuses to unlink a live socket", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-live-"));
  const workspace = path.join(root, "workspace"), runtime = path.join(root, "runtime");
  await fs.mkdir(workspace); await fs.mkdir(runtime);
  const target = socketPath(runtime, workspaceId(await fs.realpath(workspace)));
  const owner = net.createServer(socket => socket.end()); await new Promise<void>(resolve => owner.listen(target, resolve));
  const server = new IpcServer(runtime, workspace, adapter, logger);
  await assert.rejects(server.start(), /already owns/);
  assert.equal((await fs.lstat(target)).isSocket(), true);
  await new Promise<void>(resolve => owner.close(() => resolve()));
  await fs.rm(root, { recursive: true });
});
