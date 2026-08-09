import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileLogger } from "../src/common/logging";

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
