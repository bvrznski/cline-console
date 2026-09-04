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

test("queue add accepts positional task files without an explicit file flag", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-add-positional-"));
  const first = path.join(root, "9.1"), second = path.join(root, "9.2");
  await fs.writeFile(first, "phase 9.1");
  await fs.writeFile(second, "phase 9.2");
  const tasks = await readTasks([first, second]);
  assert.deepEqual(tasks.map(task => task.sourcePath), [first, second]);
  assert.deepEqual(tasks.map(task => task.prompt), ["phase 9.1", "phase 9.2"]);
  await fs.rm(root, { recursive: true });
});

test("queue add positional input rejects missing paths and option-like values", async () => {
  await assert.rejects(readTasks([]), /requires one or more task file paths/);
  await assert.rejects(readTasks(["--unknown"]), /requires one or more task file paths/);
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

test("directory input filters files strictly newer than a reference file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-newer-"));
  const tasks = path.join(root, "tasks"), older = path.join(tasks, "older.md"), newer = path.join(tasks, "newer.md"), reference = path.join(root, "reference");
  await fs.mkdir(tasks);
  await fs.writeFile(older, "older");
  await fs.writeFile(newer, "newer");
  await fs.writeFile(reference, "reference");
  await fs.utimes(older, new Date(1_000), new Date(1_000));
  await fs.utimes(reference, new Date(2_000), new Date(2_000));
  await fs.utimes(newer, new Date(3_000), new Date(3_000));
  const result = await readTasks(["--dir", tasks, "--newer-than", reference]);
  assert.deepEqual(result.map(task => task.sourcePath), [newer]);
  await fs.rm(root, { recursive: true });
});

test("newer-than requires directory mode and at least one matching file", async () => {
  await assert.rejects(readTasks(["--file", "task.md", "--newer-than", "reference"]), /valid only with --dir/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-newer-empty-"));
  const tasks = path.join(root, "tasks"), candidate = path.join(tasks, "task.md"), reference = path.join(root, "reference");
  await fs.mkdir(tasks);
  await fs.writeFile(candidate, "task");
  await fs.writeFile(reference, "reference");
  await fs.utimes(candidate, new Date(1_000), new Date(1_000));
  await fs.utimes(reference, new Date(2_000), new Date(2_000));
  await assert.rejects(readTasks(["--dir", tasks, "--newer-than", reference]), /No regular task files newer/);
  await fs.rm(root, { recursive: true });
});
