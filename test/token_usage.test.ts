import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { formatTokenCount } from "../src/common/token_count";
import { attachTokenUsage, readClineTokenUsage } from "../src/integrations/cline/token_usage";
import type { QueueStatus } from "../src/ipc/types";

test("Cline token usage reads exact managed sessions and ignores unrelated tasks", async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "cline-console-token-usage-"));
  await fs.mkdir(path.join(storage, "state"));
  await fs.writeFile(path.join(storage, "state", "taskHistory.json"), JSON.stringify([
    { id: "owned", tokensIn: 1_200, tokensOut: 34, cacheReads: 500, cacheWrites: 20 },
    { id: "manual", tokensIn: 999_999, tokensOut: 99 }
  ]));
  try {
    const usage = await readClineTokenUsage(["owned"], storage);
    assert.deepEqual(usage.get("owned"), { input: 1_200, output: 34, total: 1_234, cacheReads: 500, cacheWrites: 20, sessions: 1 });
    assert.equal(usage.has("manual"), false);
    const status = attachTokenUsage({ workspace: "/repo", paused: false, queueLength: 1, running: 1, queued: 0, completed: 0, failed: 0, items: [
      { id: "queue-1", kind: "task", state: "running", title: "Task", sourcePath: "/task.md", queuedAt: "now", sessionId: "owned" }
    ] }, usage, ["owned", "owned"]);
    assert.equal(status.tokenUsage?.total, 1_234);
    assert.equal(status.tokenUsage?.sessions, 1);
    assert.equal(status.items[0].tokenUsage?.total, 1_234);
  } finally {
    await fs.rm(storage, { recursive: true });
  }
});

test("token counts use compact stable units", () => {
  assert.equal(formatTokenCount(undefined), "--");
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(1_234), "1.23K");
  assert.equal(formatTokenCount(12_345_678), "12.3M");
  assert.equal(formatTokenCount(1_250_000_000), "1.25B");
});
