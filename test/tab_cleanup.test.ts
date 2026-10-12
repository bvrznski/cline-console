import test from "node:test";
import assert from "node:assert/strict";
import { cleanupTaskTabs } from "../src/extension/tab_cleanup";

test("task tab cleanup closes only tracked clean files inside the workspace", async () => {
  const closed: string[] = [];
  const tab = (uri: string, dirty = false) => ({ uris: [uri], dirty, close: async () => { closed.push(uri); return true; } });
  const tracked = new Set(["/repo/src/task.ts", "/repo/src/dirty.ts", "/other/outside.ts"]);
  const result = await cleanupTaskTabs([
    tab("/repo/src/task.ts"), tab("/repo/src/dirty.ts", true), tab("/repo/src/preexisting.ts"), tab("/other/outside.ts")
  ], tracked, "/repo");
  assert.deepEqual(result, { closed: 1, preservedDirty: 1, preservedPinned: 0 });
  assert.deepEqual(closed, ["/repo/src/task.ts"]);
  assert.equal(tracked.has("/repo/src/task.ts"), false);
  assert.equal(tracked.has("/repo/src/dirty.ts"), true);
});

test("task tab cleanup retains tracking when VS Code refuses to close a tab", async () => {
  const tracked = new Set(["/repo/task.ts"]);
  assert.deepEqual(await cleanupTaskTabs([
    { uris: ["/repo/task.ts"], dirty: false, close: async () => false }
  ], tracked, "/repo"), { closed: 0, preservedDirty: 0, preservedPinned: 0 });
  assert.equal(tracked.has("/repo/task.ts"), true);
});

test("task tab cleanup closes restored and diff tabs but preserves pinned and dirty tabs", async () => {
  const closed: string[] = [];
  const tab = (name: string, uris: string[], options: { dirty?: boolean; pinned?: boolean } = {}) => ({
    uris, dirty: options.dirty ?? false, pinned: options.pinned,
    close: async () => { closed.push(name); return true; }
  });
  const result = await cleanupTaskTabs([
    tab("restored", ["/repo/src/restored.ts"]),
    tab("diff", ["/repo/src/before.ts", "/repo/src/after.ts"]),
    tab("pinned", ["/repo/README.md"], { pinned: true }),
    tab("dirty", ["/repo/src/dirty.ts"], { dirty: true }),
    tab("outside", ["/other/file.ts"])
  ], new Set(), "/repo", true);
  assert.deepEqual(result, { closed: 2, preservedDirty: 1, preservedPinned: 1 });
  assert.deepEqual(closed, ["restored", "diff"]);
});
