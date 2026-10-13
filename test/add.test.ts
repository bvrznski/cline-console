import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatExpandedRangeNotice, readTaskFiles, readTasks, splitTaskBatches } from "../src/client/commands/add";
import { queueScaleWarning, RECOMMENDED_QUEUE_TASK_LIMIT } from "../src/common/queue_limits";

test("queues accept 1000 tasks silently and warn only above the recommended limit", () => {
  assert.equal(RECOMMENDED_QUEUE_TASK_LIMIT, 1_000);
  assert.equal(queueScaleWarning(999, 1), undefined);
  assert.equal(queueScaleWarning(800, 200), undefined);
  assert.match(queueScaleWarning(800, 201) ?? "", /1001 active tasks.*recommended 1000-task limit/);
  assert.match(queueScaleWarning(0, 1_001, true) ?? "", /1001 active tasks/);
});

test("large task payloads are split below the IPC frame limit without reordering", () => {
  const tasks = [
    { sourcePath: "/1.md", prompt: "a".repeat(80) },
    { sourcePath: "/2.md", prompt: "b".repeat(80) },
    { sourcePath: "/3.md", prompt: "c".repeat(80) }
  ];
  const batches = splitTaskBatches(tasks, 180);
  assert.deepEqual(batches.flat().map(task => task.sourcePath), tasks.map(task => task.sourcePath));
  assert.ok(batches.length > 1);
  assert.ok(batches.every(batch => Buffer.byteLength(JSON.stringify({ tasks: batch }), "utf8") <= 180));
  assert.throws(() => splitTaskBatches([{ sourcePath: "/huge.md", prompt: "x".repeat(200) }], 100), /exceeds the safe IPC payload size/);
});

test("batch splitting serializes each task once instead of rescanning the growing batch", () => {
  let serializations = 0;
  const tasks = Array.from({ length: 2_000 }, (_, index) => ({
    sourcePath: `/${index}.md`,
    prompt: "x".repeat(64),
    toJSON() {
      serializations += 1;
      return { sourcePath: this.sourcePath, prompt: this.prompt };
    }
  }));
  const batches = splitTaskBatches(tasks, 16 * 1024);
  assert.equal(serializations, tasks.length);
  assert.equal(batches.flat().length, tasks.length);
});

test("relative task paths prefer cwd and fall back to workspace without changing ranges", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-path-resolution-"));
  try {
    const nested = path.join(root, ".phases");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, "TASK.md"), "local task");
    await fs.writeFile(path.join(root, "TASK.md"), "root task");
    const options = { baseDirectory: nested, workspaceDirectory: root };
    assert.equal((await readTasks([".phases/TASK.md"], options)).tasks[0].prompt, "local task");
    assert.equal((await readTasks(["TASK.md"], options)).tasks[0].prompt, "local task");
    await fs.writeFile(path.join(nested, "1.8.md"), "local phase");
    await fs.writeFile(path.join(root, "1.8.md"), "root phase");
    assert.equal((await readTasks(["1.8", "-", "1.8"], options)).tasks[0].prompt, "local phase");
    await assert.rejects(readTasks(["missing.md"], options), /Tried:/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

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
  const { tasks } = await readTasks([first, second]);
  assert.deepEqual(tasks.map(task => task.sourcePath), [first, second]);
  assert.deepEqual(tasks.map(task => task.prompt), ["phase 9.1", "phase 9.2"]);
  await fs.rm(root, { recursive: true });
});

test("queue add reads an ordered path manifest with relative paths and comments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-add-manifest-"));
  try {
    await fs.writeFile(path.join(root, "one.md"), "first");
    await fs.writeFile(path.join(root, "two.md"), "second");
    const manifest = path.join(root, "TASKS.txt");
    await fs.writeFile(manifest, "# ordered tasks\ntwo.md\n\none.md\n");
    const { tasks } = await readTasks(["--from", manifest]);
    assert.deepEqual(tasks.map(task => task.prompt), ["second", "first"]);
    assert.deepEqual(tasks.map(task => path.basename(task.sourcePath)), ["two.md", "one.md"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("queue add positional input rejects missing paths and option-like values", async () => {
  await assert.rejects(readTasks([]), /requires one or more task file paths/);
  await assert.rejects(readTasks(["--unknown"]), /requires one or more task file paths/);
});

test("queue add expands an inclusive sibling-file integer range", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-add-range-"));
  await fs.writeFile(path.join(root, "10.14"), "phase 14");
  await fs.writeFile(path.join(root, "10.16"), "phase 16");
  await fs.writeFile(path.join(root, "10.30"), "phase 30");
  await fs.writeFile(path.join(root, "10.31"), "outside");
  await fs.writeFile(path.join(root, "11.15"), "other prefix");
  const { tasks, expandedRange } = await readTasks([path.join(root, "10.14"), "-", "30"]);
  assert.deepEqual(tasks.map(task => path.basename(task.sourcePath)), ["10.14", "10.16", "10.30"]);
  assert.deepEqual(tasks.map(task => task.prompt), ["phase 14", "phase 16", "phase 30"]);
  assert.equal(expandedRange?.length, 3);
  assert.match(formatExpandedRangeNotice(expandedRange!), /Expanded range \(3\): 10\.14, 10\.16, 10\.30/);
  await fs.rm(root, { recursive: true });
});

test("queue add range supports file flags and matching full end names", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-add-range-file-"));
  await fs.writeFile(path.join(root, "10.08.md"), "phase 8");
  await fs.writeFile(path.join(root, "10.10.md"), "phase 10");
  const { tasks } = await readTasks(["--file", path.join(root, "10.08.md"), "-", "10.10.md"]);
  assert.deepEqual(tasks.map(task => path.basename(task.sourcePath)), ["10.08.md", "10.10.md"]);
  await assert.rejects(readTasks([path.join(root, "10.10.md"), "-", "8"]), /precedes start/);
  await fs.rm(root, { recursive: true });
});

test("queue add range accepts extensionless end names when start has an extension", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-add-range-ext-end-"));
  await fs.writeFile(path.join(root, "0.12.md"), "phase 12");
  await fs.writeFile(path.join(root, "0.15.md"), "phase 15");
  await fs.writeFile(path.join(root, "0.20.md"), "phase 20");
  const { tasks } = await readTasks([path.join(root, "0.12.md"), "-", "0.20"]);
  assert.deepEqual(tasks.map(task => path.basename(task.sourcePath)), ["0.12.md", "0.15.md", "0.20.md"]);
  await fs.rm(root, { recursive: true });
});

test("queue add range is extension agnostic when start omits an extension", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-add-range-ext-start-"));
  await fs.writeFile(path.join(root, "0.12.md"), "phase 12");
  await fs.writeFile(path.join(root, "0.16.md"), "phase 16");
  await fs.writeFile(path.join(root, "0.20.md"), "phase 20");
  const { tasks } = await readTasks([path.join(root, "0.12"), "-", "0.20"]);
  assert.deepEqual(tasks.map(task => path.basename(task.sourcePath)), ["0.12.md", "0.16.md", "0.20.md"]);
  await fs.rm(root, { recursive: true });
});

test("queue add range spans major.minor version tuples", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-add-range-version-"));
  const files = ["0.12.md", "0.13.md", "0.20.md", "1.0.md", "1.10.md", "2.14.md", "2.15.md", "2.16.md", "roadmap"];
  for (const name of files) await fs.writeFile(path.join(root, name), name);
  const { tasks } = await readTasks([path.join(root, "0.13"), "-", "2.15"]);
  assert.deepEqual(tasks.map(task => path.basename(task.sourcePath)), [
    "0.13.md", "0.20.md", "1.0.md", "1.10.md", "2.14.md", "2.15.md"
  ]);
  await fs.rm(root, { recursive: true });
});

test("queue add range resolves phase tokens inside prefixed and suffixed filenames", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-add-range-prefixed-"));
  const files = [
    "phase_23.99_outside.md",
    "phase_24.0_foundation.md",
    "24.1_known-good_baseline.md",
    "milestone-24.10-health-check.txt",
    "24.21_closure",
    "phase_24.22_outside.md",
    "phase_124.0_not-a-match.md"
  ];
  for (const name of files) await fs.writeFile(path.join(root, name), name);
  const { tasks } = await readTasks([path.join(root, "24.0"), "-", "24.21"]);
  assert.deepEqual(tasks.map(task => path.basename(task.sourcePath)), [
    "phase_24.0_foundation.md",
    "24.1_known-good_baseline.md",
    "milestone-24.10-health-check.txt",
    "24.21_closure"
  ]);
  await fs.rm(root, { recursive: true });
});

test("queue add range keeps one file per number when extension matching is ambiguous", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-add-range-dedupe-"));
  await fs.writeFile(path.join(root, "0.12"), "bare 12");
  await fs.writeFile(path.join(root, "0.12.md"), "md 12");
  await fs.writeFile(path.join(root, "0.13.md"), "md 13");
  const { tasks } = await readTasks([path.join(root, "0.12"), "-", "0.13"]);
  assert.deepEqual(tasks.map(task => path.basename(task.sourcePath)), ["0.12", "0.13.md"]);
  await fs.rm(root, { recursive: true });
});

test("add directory recursively discovers regular files in deterministic relative-path order", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-add-dir-"));
  const nested = path.join(root, "nested"); await fs.mkdir(nested);
  await fs.writeFile(path.join(root, "b.md"), "B");
  await fs.writeFile(path.join(root, "a.md"), "A");
  await fs.writeFile(path.join(nested, "c.md"), "C");
  await fs.symlink(path.join(root, "a.md"), path.join(root, "linked.md"));
  const { tasks } = await readTasks(["-d", root]);
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
  const { tasks: result } = await readTasks(["--dir", tasks, "--newer-than", reference]);
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
