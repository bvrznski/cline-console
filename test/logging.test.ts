import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { combineLoggers, fileLogger, type Logger } from "../src/common/logging";

test("file logger creates a private log without prompt content supplied elsewhere", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-log-"));
  const previous = process.env.XDG_STATE_HOME; process.env.XDG_STATE_HOME = root;
  try {
    fileLogger("info").info("queue event");
    const directory = path.join(root, "cline-console"), file = path.join(directory, "cline-console.log");
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.match(await fs.readFile(file, "utf8"), /INFO queue event/);
  } finally { previous === undefined ? delete process.env.XDG_STATE_HOME : process.env.XDG_STATE_HOME = previous; await fs.rm(root, { recursive: true }); }
});

test("file logger falls back without crashing when its state path is unwritable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-log-failure-"));
  const blocked = path.join(root, "not-a-directory");
  await fs.writeFile(blocked, "blocked");
  const previous = process.env.XDG_STATE_HOME;
  const originalWrite = process.stderr.write;
  let stderr = "";
  process.env.XDG_STATE_HOME = blocked;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const logger = fileLogger("info");
    assert.doesNotThrow(() => logger.error("daemon remains alive"));
    assert.match(stderr, /File logging unavailable/);
    assert.match(stderr, /daemon remains alive/);
  } finally {
    process.stderr.write = originalWrite;
    previous === undefined ? delete process.env.XDG_STATE_HOME : process.env.XDG_STATE_HOME = previous;
    await fs.rm(root, { recursive: true });
  }
});

test("combined logger isolates a failing sink", () => {
  const received: string[] = [];
  const failing: Logger = { error() { throw new Error("sink failed"); }, info() { throw new Error("sink failed"); }, debug() { throw new Error("sink failed"); } };
  const healthy: Logger = { error(message) { received.push(message); }, info(message) { received.push(message); }, debug(message) { received.push(message); } };
  const originalWrite = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    assert.doesNotThrow(() => combineLoggers(failing, healthy).info("queue completed"));
    assert.deepEqual(received, ["queue completed"]);
  } finally { process.stderr.write = originalWrite; }
});
