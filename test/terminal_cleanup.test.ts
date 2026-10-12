import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cleanupTaskTerminals, cleanupTaskTerminalsWithRetries, isIdleWorkspaceShell } from "../src/extension/terminal_cleanup";

test("cleanup closes idle workspace shells regardless of display name", async () => {
  const closed: number[] = [];
  const terminals = ["Cline", "Cline #2", "bash", "Cline busy", "Cline active", "[keep] personal"].map((name, index) => ({
    name, processId: Promise.resolve(index + 1), dispose: () => { closed.push(index + 1); }
  }));
  const workspaces: string[] = [];
  assert.equal(await cleanupTaskTerminals(terminals, "/workspace", async (pid, workspace) => {
    workspaces.push(workspace); return pid !== 4;
  }, terminal => terminal === terminals[4]), 3);
  assert.deepEqual(closed, [1, 2, 3]);
  assert.ok(workspaces.every(value => value === "/workspace"));
});

test("cleanup preserves unknown processes and isolates disposal errors", async () => {
  let closed = false;
  assert.equal(await cleanupTaskTerminals([
    { name: "Cline", processId: Promise.resolve(undefined), dispose() { throw Error("unknown"); } },
    { name: "Cline", processId: Promise.resolve(1), dispose() { throw Error("closed already"); } },
    { name: "Cline", processId: Promise.resolve(2), dispose() { closed = true; } }
  ], "/workspace", async () => true), 1);
  assert.equal(closed, true);
});

test("cleanup rechecks protection after asynchronous idle inspection", async () => {
  let protectedNow = false;
  assert.equal(await cleanupTaskTerminals([
    { name: "Cline", processId: Promise.resolve(1), dispose() { assert.fail("protected"); } }
  ], "/workspace", async () => { protectedNow = true; return true; }, () => protectedNow), 0);
});

test("cleanup retries terminals that become idle shortly after task completion", async () => {
  let checks = 0;
  let disposed = false;
  const terminal = { name: "Cline", processId: Promise.resolve(42), dispose() { disposed = true; } };
  const result = await cleanupTaskTerminalsWithRetries(
    () => disposed ? [] : [terminal], "/workspace",
    async () => ++checks >= 2, () => false, [0, 1]
  );
  assert.deepEqual(result, { closed: 1, passes: 2 });
  assert.equal(disposed, true);
});

test("cleanup keeps retrying busy terminals without disposing them", async () => {
  const terminal = { name: "Cline", processId: Promise.resolve(42), dispose() { assert.fail("busy terminal"); } };
  const result = await cleanupTaskTerminalsWithRetries(
    () => [terminal], "/workspace", async () => true, () => true, [0, 1, 1]
  );
  assert.deepEqual(result, { closed: 0, passes: 3 });
});

test("process inspection rejects invalid and non-shell processes", async () => {
  assert.equal(await isIdleWorkspaceShell(-1, process.cwd()), false);
  assert.equal(await isIdleWorkspaceShell(process.pid, process.cwd()), false);
});

test("real idle shell is eligible only inside its workspace", { skip: process.platform !== "linux", timeout: 5000 }, async () => {
  const shell = spawn("/bin/bash", ["--noprofile", "--norc"], { cwd: process.cwd(), stdio: "pipe" });
  await once(shell, "spawn");
  try {
    assert.equal(await isIdleWorkspaceShell(shell.pid!, process.cwd()), true);
    assert.equal(await isIdleWorkspaceShell(shell.pid!, "/proc"), false);
  } finally {
    const exited = once(shell, "exit");
    shell.kill("SIGKILL");
    await exited;
  }
});
