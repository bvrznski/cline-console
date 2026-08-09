import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { readInput } from "../src/client/commands/new";

test("file input is preserved exactly", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-input-"));
  const file = path.join(directory, "task.md"), text = "hello\r\n☃\n```\n$HOME\n```\n";
  await fs.writeFile(file, text);
  assert.equal(await readInput(["-f", file]), text);
  await fs.rm(directory, { recursive: true });
});

test("stdin input is preserved exactly", async () => {
  const text = "first\nsecond\n";
  assert.equal(await readInput(["-"], Readable.from([Buffer.from(text)])), text);
});

test("quoted prompt is accepted as one argument", async () => assert.equal(await readInput(["do the thing"]), "do the thing"));
