import test from "node:test";
import assert from "node:assert/strict";
import stringWidth from "string-width";
import { parseArgs } from "../src/client/grammar";
import { hasActiveQueue, renderWatch, shouldWarnCompanionFailure, visiblePersistedQueues, watchTerminalTitleSequence, watchText } from "../src/client/commands/watch";
import type { QueueStatus } from "../src/ipc/types";

test("watch accepts an optional workspace in either order", () => {
  assert.equal(parseArgs(["--watch"]).command, "watch");
  assert.equal(parseArgs(["-w", "/tmp", "--watch"]).workspace, "/tmp");
  assert.equal(parseArgs(["--watch", "-w", "/tmp"]).workspace, "/tmp");
  assert.throws(() => parseArgs(["queue", "--watch"]));
});

test("watch marks its terminal as protected from task cleanup", () => {
  assert.equal(watchTerminalTitleSequence(), "\x1b]0;[keep] Cline Console Watch\x07");
  assert.equal(watchTerminalTitleSequence(""), "\x1b]0;\x07");
});

test("watch warns only after a sustained companion outage, not three slow polls", () => {
  const since = 1_000;
  assert.equal(shouldWarnCompanionFailure(3, since, since + 60_000), false);
  assert.equal(shouldWarnCompanionFailure(4, since, since + 19_999), false);
  assert.equal(shouldWarnCompanionFailure(4, since, since + 20_000), true);
});

test("watch hides workspaces without active queued work", () => {
  const persisted = [
    { workspace: "/open", paused: false, queueLength: 1, running: 0, queued: 1, completed: 0, failed: 0, items: [{ state: "queued", title: "Next" }] },
    { workspace: "/closed", paused: false, queueLength: 1, running: 0, queued: 0, completed: 0, failed: 0, items: [{ state: "interrupted", title: "Resume" }] },
    { workspace: "/empty", paused: false, queueLength: 0, running: 0, queued: 0, completed: 2, failed: 0, items: [{ state: "completed", title: "Done" }] }
  ] as QueueStatus[];
  const registrations = [{ workspace: "/open" }, { workspace: "/empty" }];
  assert.deepEqual(visiblePersistedQueues(persisted, registrations).map(queue => queue.workspace), ["/open"]);
  assert.deepEqual(visiblePersistedQueues(persisted, registrations, "/closed").map(queue => queue.workspace), ["/closed"]);
  assert.deepEqual(visiblePersistedQueues(persisted, registrations, "/empty"), []);
  assert.equal(hasActiveQueue(persisted[0]), true);
  assert.equal(hasActiveQueue(persisted[1]), true);
  assert.equal(hasActiveQueue(persisted[2]), false);
});

test("watch shows interrupted current task before queued work and separates workspaces", () => {
  const queue = { workspace: "/one", paused: false, queued: 1, completed: 2, failed: 0, items: [
    { state: "interrupted", title: "Phase 3.9", position: 1 },
    { state: "queued", title: "Phase 3.10", position: 2 }
  ] } as QueueStatus;
  const text = renderWatch([{ workspace: "/one", queue }, { workspace: "/two", error: "Offline" }]);
  assert.match(text, /CURRENT: \[interrupted\] Phase 3.9/);
  assert.ok(text.indexOf("Phase 3.9") < text.indexOf("Phase 3.10"));
  assert.match(text, /─.*\n\/two\nOffline/);
  assert.ok(!text.includes("\x1b"));
  const colored = renderWatch([{ workspace: "/one", queue }], 100, true);
  assert.match(colored, /\x1b\[36mCURRENT:/);
  assert.match(colored, /\x1b\[35m\[interrupted\]/);
  assert.match(colored, /\x1b\[33m \| ELAPSED/);
  assert.match(colored, /\x1b\[35m \| LEFT/);
});

test("watch displays per-task, workspace, and global managed token usage", () => {
  const first = { input: 1_000_000, output: 20_000, total: 1_020_000, cacheReads: 10_000, cacheWrites: 2_000, sessions: 1 };
  const second = { input: 2_000_000, output: 30_000, total: 2_030_000, cacheReads: 0, cacheWrites: 0, sessions: 2 };
  const output = renderWatch([
    { workspace: "/one", queue: { workspace: "/one", paused: false, queueLength: 1, running: 1, queued: 0, completed: 0, failed: 0, tokenUsage: first, items: [
      { id: "one", kind: "task", state: "running", title: "Current", sourcePath: "/one.md", queuedAt: "now", tokenUsage: first }
    ] } },
    { workspace: "/two", queue: { workspace: "/two", paused: false, queueLength: 0, running: 0, queued: 0, completed: 0, failed: 0, tokenUsage: second, items: [] } }
  ], 180);
  assert.match(output, /GLOBAL TOKENS: 3\.05M total \| 3M in \| 50K out/);
  assert.match(output, /TOKENS: 1\.02M total \| 1M in \| 20K out/);
  assert.match(output, /Task tokens: 1\.02M total \| 1M in \| 20K out/);
});

test("watch sanitizes terminal control bytes and clips long titles", () => {
  assert.ok(!watchText("evil\x1b[2J\r\n\x9b31m").includes("\x1b"));
  assert.ok(renderWatch([{ workspace: "a".repeat(200) }], 40).split("\n").every(line => line.length <= 39));
  assert.match(renderWatch([]), /No active queues/);
});

test("dashboard includes counters and wall time without implying active execution", () => {
  const queue = { workspace: "/one", paused: true, running: 0, queued: 0, completed: 8, failed: 1,
    items: [{ state: "interrupted", title: "Task", sourcePath: "/one/task.md", dispatchedAt: "2026-09-25T10:00:00Z", activeMs: 0 }]
  } as QueueStatus;
  const output = renderWatch([{ workspace: "/one", queue }], 120, false, 0, Date.parse("2026-09-25T11:02:03Z"));
  assert.match(output, /PAUSED/);
  assert.match(output, /TASK COUNTS/);
  assert.match(output, /Active execution: 00:00:00 \| Wall since dispatch: 01:02:03/);
  assert.match(output, /Source: \/one\/task.md/);
  assert.match(output, /AHEAD/);
  assert.ok(renderWatch([{ workspace: "/one", queue }], 10).split("\n").every(line => line.length <= 9));
});

test("queue columns adapt to terminal width and reserve remaining space for titles", () => {
  const queue = { workspace: "/one", queued: 1, completed: 0, failed: 0, items: [
    { state: "queued", position: 1234, title: "long task title ".repeat(20) }
  ] } as QueueStatus;
  for (const width of [20, 35, 60, 80, 160]) {
    const text = renderWatch([{ workspace: "/one", queue }], width);
    assert.ok(text.split("\n").every(line => line.length <= width - 1));
    assert.ok(text.includes("long task"));
    assert.equal(text.includes("START IN"), width >= 71);
    assert.equal(text.includes("AHEAD"), width >= 91);
  }
});

test("watch keeps vertical borders aligned for wide and combining task text", () => {
  const queue = { workspace: "/one", queued: 2, completed: 0, failed: 0, items: [
    { state: "queued", position: 1, title: "wide 🚀 任務" },
    { state: "queued", position: 2, title: "combining e\u0301 task" }
  ] } as QueueStatus;
  const lines = renderWatch([{ workspace: "/one", queue }], 80).split("\n");
  const queueHeader = lines.findIndex(line => line.includes("TASK") && line.startsWith("│"));
  assert.ok(queueHeader > 0);
  const tableLines = lines.slice(queueHeader - 1).filter(line => /^[┌├└│]/u.test(line));
  assert.ok(tableLines.length >= 5);
  assert.ok(tableLines.every(line => stringWidth(line) === 79));
  const verticalColumns = tableLines
    .filter(line => line.startsWith("│"))
    .map(line => Array.from(line).reduce<number[]>((columns, character, index, characters) => {
      if (character === "│") columns.push(stringWidth(characters.slice(0, index).join("")));
      return columns;
    }, []));
  assert.ok(verticalColumns.every(columns => JSON.stringify(columns) === JSON.stringify(verticalColumns[0])));
});

test("watch replaces identical batch ages with distinct ahead counts", () => {
  const queuedAt = "2026-09-25T10:00:00Z";
  const queue = { workspace: "/one", running: 1, queued: 3, completed: 0, failed: 0, items: [
    { state: "running", position: 1, title: "Current", queuedAt },
    { state: "queued", position: 2, title: "First waiting", queuedAt },
    { state: "queued", position: 3, title: "Second waiting", queuedAt },
    { state: "queued", position: 4, title: "Third waiting", queuedAt }
  ] } as QueueStatus;
  const output = renderWatch([{ workspace: "/one", queue }], 120, false, 0, Date.parse("2026-09-25T11:00:00Z"));
  assert.match(output, /AHEAD/);
  assert.match(output, /queued\s*│\s*1\s*│\s*--\s*│First waiting/);
  assert.match(output, /queued\s*│\s*2\s*│\s*--\s*│Second waiting/);
  assert.match(output, /queued\s*│\s*3\s*│\s*--\s*│Third waiting/);
  assert.ok(!output.includes("QUEUED AGE"));
});

test("watch estimates current and queued remaining time from completed workspace tasks", () => {
  const queue = { workspace: "/one", running: 1, queued: 2, completed: 2, failed: 0, timing: { sampleCount: 2, averageMs: 15 * 60_000, estimateMs: 20 * 60_000, lastMs: 22 * 60_000 }, items: [
    { state: "running", position: 1, title: "Current", dispatchedAt: "2026-09-25T10:00:00Z" },
    { state: "queued", position: 2, title: "First waiting" },
    { state: "queued", position: 3, title: "Second waiting" }
  ] } as QueueStatus;
  const output = renderWatch([{ workspace: "/one", queue }], 180, false, 0, Date.parse("2026-09-25T10:05:00Z"));
  assert.match(output, /ESTIMATES/);
  assert.match(output, /QUEUE LEFT\s+│QUEUE ETA\s+│END\s+│CONFIDENCE/);
  assert.match(output, /3 tasks\s+│55m 00s\s+│\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s+│low/);
  assert.match(output, /CURRENT ELAPSED\s+│CURRENT LEFT\s+│LIKELY/);
  assert.match(output, /00:05:00\s+│15m 00s\s+│00:20:00/);
  assert.match(output, /AVERAGE/);
  assert.match(output, /00:15:00/);
  assert.match(output, /LAST/);
  assert.match(output, /00:22:00/);
  assert.match(output, /START IN/);
  assert.match(output, /queued\s*│\s*1\s*│\s*15m 00s\s*│First waiting/);
  assert.match(output, /queued\s*│\s*2\s*│\s*35m 00s\s*│Second waiting/);
});

test("watch shows an explicit queue completion counter without inventing an ETA", () => {
  const queue = { workspace: "/one", running: 1, queued: 1, completed: 0, failed: 0, timing: { sampleCount: 0 }, items: [
    { state: "running", position: 1, title: "Current", dispatchedAt: "2026-09-25T10:00:00Z" },
    { state: "queued", position: 2, title: "Waiting" }
  ] } as QueueStatus;
  const output = renderWatch([{ workspace: "/one", queue }], 140, false, 0, Date.parse("2026-09-25T10:05:00Z"));
  assert.match(output, /QUEUE LEFT\s+│QUEUE ETA\s+│END\s+│CONFIDENCE/);
  assert.match(output, /2 tasks\s+│--\s+│--\s+│none/);
});

test("watch retains an approximate active-work ETA but blocks the end date while interrupted offline", () => {
  const queue = { workspace: "/one", paused: false, queueLength: 3, running: 0, queued: 2, completed: 4, failed: 0,
    timing: { sampleCount: 4, estimateMs: 30 * 60_000, p90Ms: 40 * 60_000, confidence: "medium" }, items: [
      { state: "interrupted", position: 1, title: "Current", activeMs: 3 * 60 * 60_000 },
      { state: "queued", position: 2, title: "Waiting one" },
      { state: "queued", position: 3, title: "Waiting two" }
    ] } as QueueStatus;
  const output = renderWatch([{ workspace: "/one", queue, error: "Unavailable" }], 180, false);
  assert.match(output, /3 tasks\s+│~01h 30m active\s+│blocked \(offline\)\s+│medium \(current uncertain\)/);
});

test("watch exposes distribution, throughput, variability, and trend metrics", () => {
  const queue = { workspace: "/one", paused: false, queueLength: 0, running: 0, queued: 0, completed: 8, failed: 0, timing: {
    sampleCount: 8, averageMs: 30 * 60_000, estimateMs: 32 * 60_000,
    minMs: 10 * 60_000, maxMs: 90 * 60_000, standardDeviationMs: 20 * 60_000,
    coefficientVariation: 2 / 3, tasksPerHour: 2, recentMedianMs: 35 * 60_000,
    trend: "slower", confidence: "medium"
  }, items: [] } as QueueStatus;
  const output = renderWatch([{ workspace: "/one", queue }], 180, false);
  assert.match(output, /MIN\s+│MAX\s+│STDDEV\s+│CV/);
  assert.match(output, /00:10:00\s+│01:30:00\s+│00:20:00\s+│67%/);
  assert.match(output, /RATE/);
  assert.match(output, /2\.00 tasks\/h/);
  assert.match(output, /RECENT P50\s+│TREND/);
  assert.match(output, /00:35:00\s+│slower/);
});

test("watch freezes elapsed time while the current task is waiting", () => {
  const queue = { workspace: "/one", running: 0, queued: 1, completed: 1, failed: 0, timing: { sampleCount: 1, averageMs: 20 * 60_000 }, items: [
    { state: "waiting", position: 1, title: "Verification follow-up", activeMs: 5 * 60_000, activeSince: "2026-09-25T10:00:00Z" }
  ] } as QueueStatus;
  const output = renderWatch([{ workspace: "/one", queue }], 140, false, 0, Date.parse("2026-09-25T10:10:00Z"));
  assert.match(output, /CURRENT ELAPSED\s+│CURRENT LEFT/);
  assert.match(output, /00:05:00\s+│15m 00s/);
});

test("watch does not invent estimates without completed duration samples", () => {
  const queue = { workspace: "/one", running: 1, queued: 1, completed: 0, failed: 0, timing: { sampleCount: 0 }, items: [
    { state: "running", position: 1, title: "Current", dispatchedAt: "2026-09-25T10:00:00Z" },
    { state: "queued", position: 2, title: "Waiting" }
  ] } as QueueStatus;
  const output = renderWatch([{ workspace: "/one", queue }], 140, false, 0, Date.parse("2026-09-25T10:05:00Z"));
  assert.match(output, /CONFIDENCE/);
  assert.match(output, /none/);
  assert.match(output, /CURRENT ELAPSED\s+│CURRENT LEFT/);
  assert.match(output, /00:05:00\s+│--/);
  assert.match(output, /QUEUE ETA/);
});

test("watch uses scale-aware queued start estimates", () => {
  const dispatchedAt = "2026-09-25T10:00:00Z";
  const queue = {
    workspace: "/one", running: 1, queued: 13, completed: 4, failed: 0,
    timing: { sampleCount: 4, averageMs: 2 * 60 * 60 * 1000 },
    items: [
      { state: "running", position: 1, title: "Current", dispatchedAt },
      ...Array.from({ length: 13 }, (_, index) => ({ state: "queued", position: index + 2, title: `Waiting ${index + 1}` }))
    ]
  } as QueueStatus;
  const output = renderWatch([{ workspace: "/one", queue }], 160, false, 0, Date.parse("2026-09-25T10:30:00Z"));
  assert.match(output, /queued\s*│\s*1\s*│\s*01h 30m\s*│Waiting 1/);
  assert.match(output, /queued\s*│\s*13\s*│\s*1d 01h 30m\s*│Waiting 13/);
});

test("watch never predicts an immediate queued start while the current task exceeds its average", () => {
  const queue = {
    workspace: "/one", running: 1, queued: 2, completed: 5, failed: 0,
    timing: { sampleCount: 5, averageMs: 10 * 60 * 1000 },
    items: [
      { state: "running", position: 1, title: "Still running", dispatchedAt: "2026-09-25T10:00:00Z" },
      { state: "queued", position: 2, title: "First waiting" },
      { state: "queued", position: 3, title: "Second waiting" }
    ]
  } as QueueStatus;
  const output = renderWatch([{ workspace: "/one", queue }], 160, false, 0, Date.parse("2026-09-25T10:15:00Z"));
  assert.match(output, /CURRENT LEFT/);
  assert.match(output, /unknown \(05m 00s over likely\)/);
  assert.match(output, /QUEUE ETA/);
  assert.match(output, /~30m 00s/);
  assert.match(output, /queued\s*│\s*1\s*│\s*overdue 05m 00s\s*│First waiting/);
  assert.match(output, /queued\s*│\s*2\s*│\s*overdue 05m 00s \+ 10m 00s\s*│Second waiting/);
  assert.doesNotMatch(output, /queued\s*│\s*1\s*│\s*00m 00s/);
});

test("watch includes a competing queue's shared-model work in START IN", () => {
  const now = Date.parse("2026-10-08T12:10:00Z");
  const winner = {
    workspace: "/gordon",
    activity: { status: "running", modelIdentity: "lmstudio/model" },
    queue: {
      workspace: "/gordon", paused: false, running: 1, queued: 0, completed: 2, failed: 0,
      timing: { sampleCount: 2, estimateMs: 30 * 60_000 },
      items: [{ id: "g1", kind: "task", state: "running", title: "Gordon", sourcePath: "/g.md", queuedAt: "", activeSince: "2026-10-08T12:00:00Z" }]
    } as QueueStatus
  };
  const blocked = {
    workspace: "/rebuntu",
    activity: { status: "idle", modelConflict: { winnerWorkspace: "/gordon", modelIdentity: "lmstudio/model", interruptedAt: "2026-10-08T12:00:00Z" } },
    queue: {
      workspace: "/rebuntu", paused: true, running: 0, queued: 1, completed: 2, failed: 0,
      timing: { sampleCount: 2, estimateMs: 20 * 60_000 },
      items: [
        { id: "r1", kind: "task", state: "interrupted", title: "Interrupted", sourcePath: "/r1.md", queuedAt: "", activeMs: 5 * 60_000 },
        { id: "r2", kind: "task", state: "queued", title: "Waiting", sourcePath: "/r2.md", queuedAt: "" }
      ]
    } as QueueStatus
  };
  const output = renderWatch([winner, blocked], 180, false, 0, now);
  // Winner: 20 minutes left. Handoff: 15 seconds. Interrupted Rebuntu task:
  // 15 minutes left. Its next task therefore starts in 35m15s.
  assert.match(output, /queued\s*│\s*1\s*│\s*35m 15s\s*│Waiting/);
  const selectedOutput = renderWatch([{ ...blocked, modelPeers: [winner] }], 180, false, 0, now);
  assert.match(selectedOutput, /queued\s*│\s*1\s*│\s*35m 15s\s*│Waiting/);
});
