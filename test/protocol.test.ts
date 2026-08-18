import assert from "node:assert/strict";
import test from "node:test";
import { ClineConsoleError } from "../src/common/errors";
import { makeRequest, parseRequest, serializeResponse } from "../src/ipc/protocol";

test("IPC request round-trips without normalizing prompt text", () => {
  const prompt = "# Task\n\n```ts\nconst snowman = '☃';\n```\n";
  const request = makeRequest("newTask", "/tmp/work", { prompt });
  assert.deepEqual(parseRequest(JSON.stringify(request)), request);
  assert.equal(request.payload?.prompt, prompt);
});

test("IPC accepts workspace unfinished-task recovery", () => {
  const request = makeRequest("finishUnfinishedTasks", "/tmp/work");
  const parsed = parseRequest(JSON.stringify(request));
  assert.equal(parsed.action, request.action);
  assert.equal(parsed.workspace, request.workspace);
  assert.equal(parsed.requestId, request.requestId);
});

test("IPC rejects unsupported protocol versions", () => {
  assert.throws(() => parseRequest(JSON.stringify({ protocolVersion: 2, requestId: "x", action: "status", workspace: "/tmp" })),
    (error: unknown) => error instanceof ClineConsoleError && error.code === "PROTOCOL_MISMATCH");
});

test("response serialization is newline delimited", () => {
  assert.equal(serializeResponse({ protocolVersion: 1, requestId: "x", ok: true }), '{"protocolVersion":1,"requestId":"x","ok":true}\n');
});
