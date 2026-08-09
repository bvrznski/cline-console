import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "../common/logging";
import type { ClineAdapter } from "../integrations/cline/types";
import type { QueueStatus } from "../ipc/types";
import { waitForLegacyMessageCompletion, waitForLegacyTaskCompletion, waitForLegacyWorkspaceIdle } from "../integrations/cline/completion_monitor";

type QueueState = "queued" | "running" | "completed" | "failed";
interface QueueItem { id: string; kind?: "task" | "message"; sourcePath: string; prompt: string; targetSessionId?: string; state: QueueState; queuedAt: string; dispatchedAt?: string; finishedAt?: string; sessionId?: string; error?: string; }
interface QueueFile { version: 1; workspace: string; items: QueueItem[]; }

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

  getStatus(): QueueStatus {
    return buildQueueStatus(this.workspace, this.data.items);
  }

  private async append(items: Array<{ kind: "task" | "message"; sourcePath: string; prompt: string; targetSessionId?: string }>): Promise<{ queued: number; queueLength: number }> {
    const now = new Date().toISOString();
    const terminal = this.data.items.filter(item => item.state === "completed" || item.state === "failed").slice(-100);
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
      if (!this.abortController.signal.aborted && this.data.items.some(item => item.state === "queued" || item.state === "running")) this.kick();
    });
  }

  private async process(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      let item = this.data.items.find(candidate => candidate.state === "running");
      if (!item) {
        item = this.data.items.find(candidate => candidate.state === "queued");
        if (!item) return;
        await waitForLegacyWorkspaceIdle(this.workspace, this.abortController.signal, this.logger);
        if (this.abortController.signal.aborted) return;
        item.state = "running"; item.dispatchedAt = new Date().toISOString();
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
          : await waitForLegacyTaskCompletion(this.workspace, item.prompt, item.dispatchedAt!, this.abortController.signal, this.logger);
        item.sessionId = result.sessionId; item.finishedAt = new Date().toISOString();
        item.state = result.status === "completed" && (result.exitCode === undefined || result.exitCode === 0) ? "completed" : "failed";
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
    if (value.version === 1 && value.workspace === workspace && Array.isArray(value.items)) return buildQueueStatus(workspace, value.items);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return buildQueueStatus(workspace, []);
}

function buildQueueStatus(workspace: string, items: QueueItem[]): QueueStatus {
  const active = items.filter(item => item.state === "running" || item.state === "queued");
  return {
    workspace,
    queueLength: active.length,
    running: active.filter(item => item.state === "running").length,
    queued: active.filter(item => item.state === "queued").length,
    completed: items.filter(item => item.state === "completed").length,
    failed: items.filter(item => item.state === "failed").length,
    items: active.map((item, index) => ({
      position: index + 1,
      id: item.id,
      kind: item.kind ?? "task",
      state: item.state as "queued" | "running",
      title: firstLine(item.prompt),
      sourcePath: item.sourcePath,
      queuedAt: item.queuedAt,
      ...(item.dispatchedAt ? { dispatchedAt: item.dispatchedAt } : {})
    }))
  };
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0].trim() || "(untitled)";
}
