import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ClineConsoleError } from "../common/errors";
import { taskTitle } from "../common/task_title";
import type { Logger } from "../common/logging";
import type { ClineAdapter } from "../integrations/cline/types";
import type { QueueStatus } from "../ipc/types";
import { waitForLegacyMessageCompletion, waitForLegacyTaskCompletion, waitForLegacyWorkspaceIdle } from "../integrations/cline/completion_monitor";
import { hasExplicitRemainingWork } from "../integrations/cline/remaining_work";

type QueueState = "queued" | "running" | "completed" | "failed" | "skipped";
interface QueueItem { id: string; kind?: "task" | "message"; sourcePath: string; prompt: string; targetSessionId?: string; state: QueueState; queuedAt: string; dispatchedAt?: string; finishedAt?: string; sessionId?: string; lastCompletionMarker?: string; lastRecoveryMarker?: string; error?: string; }
interface QueueFile { version: 1; workspace: string; paused?: boolean; ignoredWaitingTaskIds?: string[]; items: QueueItem[]; }
export const TASK_DISPATCH_DELAY_MS = 30_000;
export const DISPATCH_STABILITY_DELAY_MS = 1_000;

export class TaskQueue {
  private data: QueueFile;
  private worker?: Promise<void>;
  private abortController = new AbortController();

  constructor(private readonly file: string, private readonly workspace: string, private readonly adapter: ClineAdapter, private readonly logger: Logger) {
    this.data = { version: 1, workspace, items: [] };
  }

  async start(): Promise<void> { if (this.abortController.signal.aborted) this.abortController = new AbortController(); await this.load(); this.kick(); }

  async enqueue(tasks: Array<{ sourcePath: string; prompt: string }>): Promise<{ queued: number; queueLength: number }> {
    return this.append(tasks.map(task => ({ kind: "task" as const, sourcePath: task.sourcePath, prompt: task.prompt })));
  }

  async enqueueMessages(messages: Array<{ sourcePath: string; message: string; sessionId: string }>): Promise<{ queued: number; queueLength: number }> {
    return this.append(messages.map(message => ({ kind: "message" as const, sourcePath: message.sourcePath, prompt: message.message, targetSessionId: message.sessionId })));
  }

  async replace(tasks: Array<{ sourcePath: string; prompt: string }>): Promise<{ queued: number; replaced: number; queueLength: number }> {
    const replaced = this.data.items.filter(item => item.state === "queued").length;
    const retained = this.data.items.filter(item => item.state !== "queued");
    const now = new Date().toISOString();
    this.data.items = [...retained, ...tasks.map(task => ({ id: randomUUID(), kind: "task" as const, sourcePath: task.sourcePath, prompt: task.prompt, state: "queued" as const, queuedAt: now }))];
    await this.persist();
    this.logger.info(`Replaced ${replaced} waiting item(s) with ${tasks.length} task(s) for ${this.workspace}.`);
    this.kick();
    return { queued: tasks.length, replaced, queueLength: this.data.items.filter(item => item.state === "queued" || item.state === "running").length };
  }

  historySelectors(): { prompts: string[]; taskIds: string[] } {
    const taskItems = this.data.items.filter(item => (item.kind ?? "task") === "task");
    return { prompts: [...new Set(taskItems.map(item => item.prompt))], taskIds: [...new Set(taskItems.flatMap(item => item.sessionId ? [item.sessionId] : []))] };
  }

  async clear(clearHistory?: (selectors: { prompts: string[]; taskIds: string[] }) => Promise<number>): Promise<{ cleared: number; clearedWaiting: number; clearedStaleRunning: number; queueLength: number; runningPreserved: boolean; historyDeleted: number }> {
    this.abortController.abort();
    await this.worker;
    this.abortController = new AbortController();
    const clearedWaiting = this.data.items.filter(item => item.state === "queued").length;
    const clearedStaleRunning = this.data.items.filter(item => item.state === "running").length;
    let historyDeleted = 0;
    try {
      historyDeleted = clearHistory ? await clearHistory(this.historySelectors()) : 0;
    } catch (error) {
      this.kick();
      throw error;
    }
    this.data.items = [];
    await this.persist();
    const runningPreserved = false;
    const cleared = clearedWaiting + clearedStaleRunning;
    this.logger.info(`Enforced queue clearance for ${this.workspace}: ${clearedWaiting} waiting, ${clearedStaleRunning} running, ${historyDeleted} Cline history task(s).`);
    return { cleared, clearedWaiting, clearedStaleRunning, queueLength: 0, runningPreserved, historyDeleted };
  }

  async pop(selector: string, resolvedSelector?: string, selectorType?: "file" | "title" | "id"): Promise<{ removed: boolean; id: string; title: string; sourcePath: string; queueLength: number }> {
    const waiting = this.data.items.filter(item => item.state === "queued");
    const idMatches = selectorType === "file" || selectorType === "title" ? [] : waiting.filter(item => item.id === selector);
    const pathMatches = idMatches.length || selectorType === "id" || selectorType === "title" ? [] : waiting.filter(item => item.sourcePath === selector || (resolvedSelector !== undefined && item.sourcePath === resolvedSelector));
    const titleMatches = idMatches.length || pathMatches.length || selectorType === "id" || selectorType === "file" ? [] : waiting.filter(item => firstLine(item.prompt) === selector);
    const matches = idMatches.length ? idMatches : pathMatches.length ? pathMatches : titleMatches;
    if (!matches.length) {
      const runningMatch = this.data.items.some(item => item.state === "running" && (item.id === selector || item.sourcePath === selector || item.sourcePath === resolvedSelector || firstLine(item.prompt) === selector));
      if (runningMatch) throw new ClineConsoleError("QUEUE_ITEM_RUNNING", "The matching queue item is currently running and cannot be removed.");
      throw new ClineConsoleError("QUEUE_ITEM_NOT_FOUND", "No waiting queue item matches that file path or displayed title.");
    }
    if (matches.length > 1) throw new ClineConsoleError("QUEUE_ITEM_AMBIGUOUS", "Multiple waiting queue items have that displayed title; use the file path or queue ID instead.");
    const [item] = matches;
    this.data.items = this.data.items.filter(candidate => candidate.id !== item.id);
    await this.persist();
    const queueLength = this.data.items.filter(candidate => candidate.state === "queued" || candidate.state === "running").length;
    this.logger.info(`Removed waiting queue item ${item.id} from ${this.workspace}.`);
    return { removed: true, id: item.id, title: firstLine(item.prompt), sourcePath: item.sourcePath, queueLength };
  }

  async skipWaitingTask(sessionId: string): Promise<{ skipped: boolean; sessionId: string }> {
    const ignored = new Set(this.data.ignoredWaitingTaskIds ?? []);
    ignored.add(sessionId);
    this.data.ignoredWaitingTaskIds = [...ignored].slice(-20);
    await this.persist();
    this.logger.info(`Marked incomplete Cline task ${sessionId} as skipped for queue dispatch in ${this.workspace}.`);
    return { skipped: true, sessionId };
  }

  async pause(): Promise<{ paused: boolean; queueLength: number; runningPreserved: boolean }> {
    this.data.paused = true;
    await this.persist();
    const queueLength = this.data.items.filter(item => item.state === "queued" || item.state === "running").length;
    const runningPreserved = this.data.items.some(item => item.state === "running");
    this.logger.info(`Queue paused for ${this.workspace}; active item count=${queueLength}; running item preserved=${runningPreserved}.`);
    return { paused: true, queueLength, runningPreserved };
  }

  async resume(): Promise<{ resumed: boolean; queueLength: number }> {
    this.data.paused = false;
    await this.persist();
    const queueLength = this.data.items.filter(item => item.state === "queued" || item.state === "running").length;
    if (queueLength) this.kick();
    this.logger.info(`Queue resume requested for ${this.workspace}; active item count=${queueLength}.`);
    return { resumed: queueLength > 0, queueLength };
  }

  getStatus(): QueueStatus {
    return buildQueueStatus(this.workspace, this.data.items, this.data.paused === true);
  }

  sourcePathForPrompt(prompt: string): string | undefined {
    return [...this.data.items].reverse().find(item => item.prompt === prompt)?.sourcePath;
  }

  private async append(items: Array<{ kind: "task" | "message"; sourcePath: string; prompt: string; targetSessionId?: string }>): Promise<{ queued: number; queueLength: number }> {
    const now = new Date().toISOString();
    const terminal = this.data.items.filter(item => item.state === "completed" || item.state === "failed" || item.state === "skipped").slice(-100);
    const active = this.data.items.filter(item => item.state === "queued" || item.state === "running");
    this.data.items = [...terminal, ...active, ...items.map(item => ({ id: randomUUID(), ...item, state: "queued" as const, queuedAt: now }))];
    await this.persist();
    this.logger.info(`Queued ${items.length} item(s) for ${this.workspace}.`);
    this.kick();
    return { queued: items.length, queueLength: this.data.items.filter(item => item.state === "queued" || item.state === "running").length };
  }

  private kick(): void {
    if (!this.worker) this.worker = this.process().finally(() => {
      this.worker = undefined;
      if (!this.abortController.signal.aborted && !this.data.paused && this.data.items.some(item => item.state === "queued" || item.state === "running")) this.kick();
    });
  }

  private async process(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      let item = this.data.items.find(candidate => candidate.state === "running");
      if (!item) {
        if (this.data.paused) return;
        item = this.data.items.find(candidate => candidate.state === "queued");
        if (!item) return;
        await waitForLegacyWorkspaceIdle(this.workspace, this.abortController.signal, this.logger, undefined,
          sessionId => (this.data.ignoredWaitingTaskIds ?? []).includes(sessionId));
        await abortableDelay(DISPATCH_STABILITY_DELAY_MS, this.abortController.signal);
        await waitForLegacyWorkspaceIdle(this.workspace, this.abortController.signal, this.logger, undefined,
          sessionId => (this.data.ignoredWaitingTaskIds ?? []).includes(sessionId));
        if (item.kind !== "message") {
          const delay = remainingTaskDispatchDelay(this.data.items, Date.now());
          if (delay > 0) {
            this.logger.info(`Waiting ${delay}ms before dispatching the next queued task for ${this.workspace}.`);
            await abortableDelay(delay, this.abortController.signal);
          }
        }
        await waitForLegacyWorkspaceIdle(this.workspace, this.abortController.signal, this.logger, undefined,
          sessionId => (this.data.ignoredWaitingTaskIds ?? []).includes(sessionId));
        if (this.abortController.signal.aborted || this.data.paused) return;
        if (!this.data.items.includes(item) || item.state !== "queued") continue;
        item.state = "running"; item.dispatchedAt = new Date().toISOString();
        this.data.ignoredWaitingTaskIds = [];
        await this.persist();
        try {
          if (item.kind === "message") {
            await this.adapter.sendMessage(item.prompt);
            this.logger.info(`Dispatched queued message ${item.id} from ${item.sourcePath}.`);
          } else {
            await this.adapter.newTask(item.prompt);
            this.logger.info(`Dispatched queued task ${item.id} from ${item.sourcePath}.`);
          }
        }
        catch (error) { item.state = "failed"; item.finishedAt = new Date().toISOString(); item.error = error instanceof Error ? error.message : String(error); await this.persist(); continue; }
      }
      try {
        const result = item.kind === "message"
          ? await waitForLegacyMessageCompletion(this.workspace, item.targetSessionId!, this.abortController.signal, this.logger)
          : await waitForLegacyTaskCompletion(this.workspace, item.prompt, item.dispatchedAt!, this.abortController.signal, this.logger, undefined, undefined, {
            knownSessionId: item.sessionId,
            afterCompletionMarker: item.lastCompletionMarker,
            afterRecoveryMarker: item.lastRecoveryMarker,
            onSessionObserved: async sessionId => {
              item.sessionId = sessionId;
              await this.persist();
            }
          });
        if (result.sessionId) item.sessionId = result.sessionId;
        if (item.kind !== "message" && result.status === "context_overflow") {
          item.lastRecoveryMarker = result.recoveryMarker;
          await this.persist();
          await this.adapter.sendMessage("/compact");
          this.logger.info(`Requested context compaction for Cline task ${result.sessionId}.`);
          await waitForLegacyMessageCompletion(this.workspace, result.sessionId, this.abortController.signal, this.logger);
          await this.adapter.sendMessage("Continue the current task from where you stopped. Complete all remaining work and validate it before completing the task.");
          this.logger.info(`Requested continuation after context compaction for Cline task ${result.sessionId}.`);
          continue;
        }
        if (item.kind !== "message" && result.status === "completed" && hasExplicitRemainingWork(result.completionText)) {
          item.lastCompletionMarker = result.completionMarker;
          await this.persist();
          await this.adapter.sendMessage("Complete all remaining work identified in your completion report. Do not stop at a partial implementation; finish and validate every remaining item before completing the task again.");
          this.logger.info(`Requested completion of explicitly reported remaining work for Cline task ${result.sessionId}.`);
          continue;
        }
        item.finishedAt = new Date().toISOString();
        item.state = result.status === "deleted" ? "skipped" : result.status === "completed" && (result.exitCode === undefined || result.exitCode === 0) ? "completed" : "failed";
        if (item.state === "failed") item.error = `Cline session ended with ${result.status}${result.exitCode === undefined ? "" : ` (exit ${result.exitCode})`}.`;
        await this.persist();
      } catch (error) {
        if (this.abortController.signal.aborted) return;
        item.state = "failed"; item.finishedAt = new Date().toISOString(); item.error = error instanceof Error ? error.message : String(error); await this.persist();
      }
    }
  }

  private async load(): Promise<void> {
    try {
      const value = JSON.parse(await fs.readFile(this.file, "utf8")) as QueueFile;
      if (value.version === 1 && value.workspace === this.workspace && Array.isArray(value.items)) this.data = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.logger.error(`Failed to load queue: ${String(error)}`); }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await fs.rename(temporary, this.file);
  }

  async stop(): Promise<void> { this.abortController.abort(); await this.worker; }
}

export async function readQueueStatusFile(file: string, workspace: string): Promise<QueueStatus> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as QueueFile;
    if (value.version === 1 && value.workspace === workspace && Array.isArray(value.items)) return buildQueueStatus(workspace, value.items, value.paused === true);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return buildQueueStatus(workspace, []);
}

export async function discoverPersistedQueueStatuses(directory: string): Promise<QueueStatus[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const statuses: QueueStatus[] = [];
  for (const name of names.filter(candidate => /^queue-[a-f0-9]{16}\.json$/.test(candidate)).sort()) {
    const file = path.join(directory, name);
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8")) as QueueFile;
      if (value.version === 1 && typeof value.workspace === "string" && Array.isArray(value.items)) {
        statuses.push(buildQueueStatus(value.workspace, value.items, value.paused === true));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return statuses.sort((left, right) => left.workspace.localeCompare(right.workspace));
}

function buildQueueStatus(workspace: string, items: QueueItem[], paused = false): QueueStatus {
  const active = items.filter(item => item.state === "running" || item.state === "queued");
  return {
    workspace,
    paused,
    queueLength: active.length,
    running: active.filter(item => item.state === "running").length,
    queued: active.filter(item => item.state === "queued").length,
    completed: items.filter(item => item.state === "completed").length,
    failed: items.filter(item => item.state === "failed").length,
    skipped: items.filter(item => item.state === "skipped").length,
    items: active.map((item, index) => ({
      position: index + 1,
      id: item.id,
      kind: item.kind ?? "task",
      state: item.state as "queued" | "running",
      title: taskTitle(item.prompt) ?? "(untitled)",
      sourcePath: item.sourcePath,
      queuedAt: item.queuedAt,
      ...(item.dispatchedAt ? { dispatchedAt: item.dispatchedAt } : {})
    }))
  };
}

function firstLine(value: string): string {
  return taskTitle(value) ?? "(untitled)";
}

export function remainingTaskDispatchDelay(items: Array<{ kind?: "task" | "message"; state: string; finishedAt?: string }>, now = Date.now(), delayMs = TASK_DISPATCH_DELAY_MS): number {
  const latest = items
    .filter(item => item.kind !== "message" && (item.state === "completed" || item.state === "failed") && item.finishedAt)
    .map(item => Date.parse(item.finishedAt!))
    .filter(Number.isFinite)
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  return latest ? Math.max(0, latest + delayMs - now) : 0;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
