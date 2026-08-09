import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readTaskFiles, readTasks } from "../src/client/commands/add";

test("add reads multiple task files in argument order without normalization", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-add-"));
  const first = path.join(root, "task 1.md"), second = path.join(root, "task-2.md");
  await fs.writeFile(first, "first\r\n☃\n"); await fs.writeFile(second, "second\n```\n$HOME\n```\n");
  const tasks = await readTaskFiles(["-f", first, second]);
  assert.deepEqual(tasks.map(task => task.prompt), ["first\r\n☃\n", "second\n```\n$HOME\n```\n"]);
  assert.deepEqual(tasks.map(task => task.sourcePath), [first, second]);
  await fs.rm(root, { recursive: true });
});

test("add directory recursively discovers regular files in deterministic relative-path order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-add-dir-"));
  const nested = path.join(root, "nested"); await fs.mkdir(nested);
  await fs.writeFile(path.join(root, "b.md"), "B");
  await fs.writeFile(path.join(root, "a.md"), "A");
  await fs.writeFile(path.join(nested, "c.md"), "C");
  await fs.symlink(path.join(root, "a.md"), path.join(root, "linked.md"));
  const tasks = await readTasks(["-d", root]);
  assert.deepEqual(tasks.map(task => path.relative(root, task.sourcePath)), ["a.md", "b.md", path.join("nested", "c.md")]);
  assert.deepEqual(tasks.map(task => task.prompt), ["A", "B", "C"]);
  await fs.rm(root, { recursive: true });
});

test("add rejects mixing file and directory modes", async () => {
  await assert.rejects(readTasks(["-f", "task.md", "-d", "tasks"]), /either -f files or -d directory/);
});
