import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseYoloRestartRequest, writeYoloRestartRequest } from "../src/service/restart_request";

test("YOLO restart requests are private, durable, and strictly parsed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-restart-request-"));
  const file = await writeYoloRestartRequest(directory, { workspace: "/repo", queueItemId: "queue", sessionId: "session", failureMarker: "marker", errorText: "[YOLO MODE] Too many consecutive mistakes (3)" });
  const stat = await fs.stat(file), parsed = parseYoloRestartRequest(JSON.parse(await fs.readFile(file, "utf8")));
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(parsed?.workspace, "/repo");
  assert.equal(parsed?.kind, "yolo_consecutive_mistakes");
  assert.equal(parseYoloRestartRequest({ version: 1, kind: "yolo_consecutive_mistakes" }), undefined);
  await fs.rm(directory, { recursive: true });
});
