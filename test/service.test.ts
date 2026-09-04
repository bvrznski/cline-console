import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Logger } from "../src/common/logging";
import { ClineConsoleService, probeService } from "../src/service/daemon";

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
