import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClineConsoleError } from "../src/common/errors";
import type { WorkspaceRegistration } from "../src/ipc/types";
import { resolveWorkspace, loadRegistrations, parseWorkspaceSelection, waitForWorkspaceRegistration } from "../src/client/ipc_client";
import { ensureRuntimeDirectory, registerWorkspace } from "../src/extension/workspace_registry";

const registration = (workspace: string, id: string): WorkspaceRegistration => ({ protocolVersion: 1, id, workspace, socketPath: `/tmp/${id}.sock`, pid: 1, registeredAt: new Date(0).toISOString() });

test("workspace resolution chooses the nearest registered parent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-route-"));
  const nested = path.join(root, "nested"), cwd = path.join(nested, "child");
  await fs.mkdir(cwd, { recursive: true });
  assert.equal((await resolveWorkspace([registration(root, "root"), registration(nested, "nested")], undefined, cwd)).id, "nested");
  await fs.rm(root, { recursive: true });
});

test("workspace resolution rejects ambiguity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-ambiguous-"));
  const a = path.join(root, "a"), b = path.join(root, "b"), elsewhere = path.join(root, "elsewhere");
  await Promise.all([a, b, elsewhere].map(value => fs.mkdir(value)));
  await assert.rejects(resolveWorkspace([registration(a, "a"), registration(b, "b")], undefined, elsewhere),
    (error: unknown) => error instanceof ClineConsoleError && error.code === "AMBIGUOUS_WORKSPACE");
  await fs.rm(root, { recursive: true });
});

test("registry uses private permissions and ignores malformed files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-registry-")), workspace = path.join(root, "workspace"), runtime = path.join(root, "runtime");
  await fs.mkdir(workspace); await ensureRuntimeDirectory(runtime);
  const item = await registerWorkspace(runtime, workspace);
  await fs.writeFile(path.join(runtime, "broken.json"), "{");
  const loaded = await loadRegistrations(runtime);
  assert.equal(loaded.length, 1); assert.equal(loaded[0].id, item.id);
  assert.equal((await fs.stat(runtime)).mode & 0o777, 0o700);
  await fs.rm(root, { recursive: true });
});

test("registry prunes records owned by dead processes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-dead-"));
  await fs.writeFile(path.join(root, "dead.json"), JSON.stringify({ ...registration(root, "dead"), pid: 2_147_483_647 }));
  assert.deepEqual(await loadRegistrations(root), []);
  await assert.rejects(fs.stat(path.join(root, "dead.json")));
  await fs.rm(root, { recursive: true });
});

test("workspace registration wait bridges VS Code startup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-startup-"));
  const workspace = path.join(root, "workspace"), runtime = path.join(root, "runtime");
  await fs.mkdir(workspace);
  setTimeout(() => { void registerWorkspace(runtime, workspace); }, 30);
  const item = await waitForWorkspaceRegistration(workspace, workspace, runtime, 500, 10);
  assert.equal(item.workspace, workspace);
  await fs.rm(root, { recursive: true });
});

test("interactive workspace selection accepts a valid number, ID, or exact path", () => {
  const items = [registration("/one", "one"), registration("/two", "two")];
  assert.equal(parseWorkspaceSelection(items, "2")?.workspace, "/two");
  assert.equal(parseWorkspaceSelection(items, "one")?.workspace, "/one");
  assert.equal(parseWorkspaceSelection(items, "/two")?.id, "two");
});

test("interactive workspace selection rejects cancellation and invalid input", () => {
  const items = [registration("/one", "one"), registration("/two", "two")];
  assert.equal(parseWorkspaceSelection(items, ""), undefined);
  assert.equal(parseWorkspaceSelection(items, "3"), undefined);
  assert.equal(parseWorkspaceSelection(items, "missing"), undefined);
});
