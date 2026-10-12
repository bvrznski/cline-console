import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import test from "node:test";
import type { Logger } from "../src/common/logging";
import { getLmStudioModelIdentity, probeTcp, TaskModelIdentityCache, waitForLmStudio } from "../src/extension/lmstudio_ready";

const logger: Logger = { info() {}, error() {}, debug() {} };

async function listen(): Promise<net.Server> {
  const server = net.createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

test("LM Studio readiness probe recognizes an accepting TCP endpoint", async t => {
  const server = await listen();
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(await probeTcp("127.0.0.1", address.port, 250), true);
});

test("LM Studio readiness wait holds until the endpoint becomes available", async t => {
  const reservation = await listen();
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));

  const controller = new AbortController();
  const waiting = waitForLmStudio("127.0.0.1", port, controller.signal, logger, 10);
  await new Promise(resolve => setTimeout(resolve, 30));
  const server = net.createServer(socket => socket.end());
  t.after(() => server.close());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await waiting;
});

test("LM Studio model identity is stable and model-specific", async t => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "z-model" }, { id: "a-model" }, { id: "a-model" }] }));
  });
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(await getLmStudioModelIdentity("127.0.0.1", address.port), `127.0.0.1:${address.port}/a-model,z-model`);
});

test("model identity is fetched once per running task and refreshed after suspension", async () => {
  const cache = new TaskModelIdentityCache();
  let calls = 0;
  const loader = async (host: string, port: number) => { calls += 1; return `${host}:${port}/model-${calls}`; };

  assert.equal(await cache.get("task-1", "127.0.0.1", 1234, loader), "127.0.0.1:1234/model-1");
  assert.equal(await cache.get("task-1", "127.0.0.1", 1234, loader), "127.0.0.1:1234/model-1");
  assert.equal(calls, 1);

  cache.clear();
  assert.equal(await cache.get("task-1", "127.0.0.1", 1234, loader), "127.0.0.1:1234/model-2");
  assert.equal(await cache.get("task-2", "127.0.0.1", 1234, loader), "127.0.0.1:1234/model-3");
  assert.equal(calls, 3);
});
