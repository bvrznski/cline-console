import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ClineConsoleError } from "../common/errors";
import { taskTitle } from "../common/task_title";
import type { Logger } from "../common/logging";
import type { ClineAdapter } from "../integrations/cline/types";
import type { QueueStatus } from "../ipc/types";
import { getLegacyNewTaskHandoff, waitForLegacyMessageCompletion, waitForLegacyNewTaskHandoffAcknowledgement, waitForLegacyTaskCompletion, waitForLegacyWorkspaceIdle } from "../integrations/cline/completion_monitor";
import { auditCompletionReport, extractAuditRecommendations, extractRemainingSteps } from "../integrations/cline/remaining_work";
import type { HistoryStore } from "../history/history_store";

type QueueState = "queued" | "running" | "completed" | "failed" | "skipped";
interface QueueItem { id: string; kind?: "task" | "message"; sourcePath: string; prompt: string; targetSessionId?: string; resumeSessionId?: string; state: QueueState; queuedAt: string; dispatchedAt?: string; finishedAt?: string; sessionId?: string; lastCompletionMarker?: string; lastRecoveryMarker?: string; lastFailureMarker?: string; lastTestTimeoutMarker?: string; incompleteCompletionClaims?: number; handledAuditRecommendationKeys?: string[]; error?: string; }
interface QueueFile { version: 1; workspace: string; paused?: boolean; ignoredWaitingTaskIds?: string[]; compactedNewTaskMarkers?: string[]; handledNewTaskMarkers?: string[]; items: QueueItem[]; }
export const TASK_DISPATCH_DELAY_MS = 15_000;
export const DISPATCH_STABILITY_DELAY_MS = 1_000;
export const POLICY_MESSAGE_TIMEOUT_MS = 30_000;
export const QUEUE_WORKER_RETRY_DELAY_MS = 5_000;

export interface TaskScannerOptions {
  enabled: boolean;
  terminalStabilityMs: number;
  interTaskDelayMs: number;
  detectIncompleteCompletions: boolean;
  detectTestTimeouts: boolean;
  implementAuditRecommendations: boolean;
  requirePostImplementationReport: boolean;
}

export const DEFAULT_TASK_SCANNER_OPTIONS: TaskScannerOptions = {
  enabled: true,
  terminalStabilityMs: 15_000,
  interTaskDelayMs: 15_000,
  detectIncompleteCompletions: true,
  detectTestTimeouts: true,
  implementAuditRecommendations: true,
  requirePostImplementationReport: true
};

export class TaskQueue {
  private data: QueueFile;
  private worker?: Promise<void>;
  private policyWorker?: Promise<void>;
  private abortController = new AbortController();

  constructor(private readonly file: string, private readonly workspace: string, private readonly adapter: ClineAdapter, private readonly logger: Logger, private readonly history?: HistoryStore, private readonly scanner: TaskScannerOptions = DEFAULT_TASK_SCANNER_OPTIONS) {
    this.data = { version: 1, workspace, items: [] };
  }

  async start(): Promise<void> { if (this.abortController.signal.aborted) this.abortController = new AbortController(); await this.load(); this.recordHistory("startup_reconciliation"); this.kick(); this.startPolicyMonitor(); }

  async enqueue(tasks: Array<{ sourcePath: string; prompt: string }>): Promise<{ queued: number; queueLength: number }> {
    return this.append(tasks.map(task => ({ kind: "task" as const, sourcePath: task.sourcePath, prompt: task.prompt })));
  }

  async enqueueUnfinished(tasks: Array<{ sourcePath: string; prompt: string }>): Promise<{ queued: number; skippedExisting: number; queueLength: number }> {
    const existingSources = new Set(this.data.items.map(item => item.sourcePath));
    const fresh = tasks.filter(task => !existingSources.has(task.sourcePath));
    const result = fresh.length ? await this.append(fresh.map(task => ({ kind: "task" as const, sourcePath: task.sourcePath, prompt: task.prompt, resumeSessionId: task.sourcePath.startsWith("cline-history:") ? task.sourcePath.slice("cline-history:".length) : undefined }))) : { queued: 0, queueLength: this.data.items.filter(item => item.state === "queued" || item.state === "running").length };
    return { ...result, skippedExisting: tasks.length - fresh.length };
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
    await Promise.all([this.worker, this.policyWorker]);
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
    this.data.compactedNewTaskMarkers = [];
    this.data.handledNewTaskMarkers = [];
    await this.persist();
    const runningPreserved = false;
    const cleared = clearedWaiting + clearedStaleRunning;
    this.logger.info(`Enforced queue clearance for ${this.workspace}: ${clearedWaiting} waiting, ${clearedStaleRunning} running, ${historyDeleted} Cline history task(s).`);
    this.startPolicyMonitor();
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

  private async append(items: Array<{ kind: "task" | "message"; sourcePath: string; prompt: string; targetSessionId?: string; resumeSessionId?: string }>): Promise<{ queued: number; queueLength: number }> {
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
    if (!this.worker) this.worker = this.process().catch(async error => {
      if (!this.abortController.signal.aborted) this.logger.error(`Queue worker failed safely for ${this.workspace}: ${String(error)}`);
      await abortableDelay(QUEUE_WORKER_RETRY_DELAY_MS, this.abortController.signal);
    }).finally(() => {
      this.worker = undefined;
      if (!this.abortController.signal.aborted && !this.data.paused && this.data.items.some(item => item.state === "queued" || item.state === "running")) this.kick();
    });
  }

  private startPolicyMonitor(): void {
    if (!this.policyWorker) this.policyWorker = this.monitorNewTaskHandoffs().catch(error => {
      if (!this.abortController.signal.aborted) this.logger.error(`New-task policy monitor failed safely for ${this.workspace}: ${String(error)}`);
    }).finally(() => { this.policyWorker = undefined; });
  }

  private async monitorNewTaskHandoffs(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      try {
        const handoff = await getLegacyNewTaskHandoff(this.workspace);
        if (handoff && !(this.data.handledNewTaskMarkers ?? []).includes(handoff.marker)) {
          this.recordHistoryEvent({ type: "new_task_handoff_detected", source: "scanner", observed: true, clineSessionId: handoff.sessionId, payload: { marker: handoff.marker, proposedContext: handoff.text } });
          if (this.adapter.resumeTask) {
            await withTimeout(this.adapter.resumeTask(handoff.sessionId), POLICY_MESSAGE_TIMEOUT_MS, "Timed out selecting the Cline task that requested a new-task handoff.");
            // showTaskWithId resolves before Cline's webview always finishes
            // selecting the historical task. Give the target a bounded moment
            // to become the active recipient before sending the policy message.
            await abortableDelay(DISPATCH_STABILITY_DELAY_MS, this.abortController.signal);
          }
          await withTimeout(
            this.adapter.sendMessage(newTaskHandoffFollowup(handoff.text)),
            POLICY_MESSAGE_TIMEOUT_MS,
            "Timed out requesting same-thread task completion."
          );
          const delivered = await waitForLegacyNewTaskHandoffAcknowledgement(handoff, this.abortController.signal);
          if (!delivered) throw new Error(`Cline did not record the same-thread continuation for ${handoff.marker}; delivery will be retried.`);
          this.data.handledNewTaskMarkers = [...(this.data.handledNewTaskMarkers ?? []).slice(-99), handoff.marker];
          this.data.compactedNewTaskMarkers = (this.data.compactedNewTaskMarkers ?? []).filter(marker => marker !== handoff.marker);
          await this.persist();
          this.recordHistoryEvent({ type: "same_thread_completion_requested", source: "scanner", clineSessionId: handoff.sessionId, payload: { marker: handoff.marker } });
          this.logger.info(`Requested same-thread completion for Cline task ${handoff.sessionId}.`);
        }
      } catch (error) {
        if (!this.abortController.signal.aborted) this.logger.error(`New-task handoff policy failed and will retry: ${String(error)}`);
      }
      await abortableDelay(5_000, this.abortController.signal);
    }
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
          const delay = remainingTaskDispatchDelay(this.data.items, Date.now(), this.scanner.interTaskDelayMs);
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
            if (item.resumeSessionId) {
              if (!this.adapter.resumeTask) throw new ClineConsoleError("CLINE_API_UNSUPPORTED", "Native historical resume is unavailable; refusing to start a replacement task.");
              await this.adapter.resumeTask(item.resumeSessionId);
              await this.adapter.sendMessage("Complete all unfinished work in this existing task. Validate the full original scope before completing.");
              item.sessionId = item.resumeSessionId;
              this.logger.info(`Resumed historical Cline task ${item.resumeSessionId} for queue item ${item.id}.`);
            } else {
              await this.adapter.newTask(item.prompt);
              this.logger.info(`Dispatched queued task ${item.id} from ${item.sourcePath}.`);
            }
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
            afterFailureMarker: item.lastFailureMarker,
            afterTestTimeoutMarker: item.lastTestTimeoutMarker,
            terminalStabilityMs: this.scanner.terminalStabilityMs,
            detectTestTimeouts: this.scanner.enabled && this.scanner.detectTestTimeouts,
            onSessionObserved: async sessionId => {
              item.sessionId = sessionId;
              await this.persist();
            }
          });
        if (result.sessionId) item.sessionId = result.sessionId;
        this.recordHistoryEvent({ type: "cline_task_observation", source: "cline", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: result });
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
        if (item.kind !== "message" && result.status === "task_failed") {
          item.lastFailureMarker = result.failureMarker;
          item.error = result.errorText;
          await this.persist();
          await this.adapter.sendMessage("/compact");
          this.logger.info(`Requested context compaction after Cline task failure ${result.failureMarker}.`);
          await waitForLegacyMessageCompletion(this.workspace, result.sessionId, this.abortController.signal, this.logger);
          await this.adapter.sendMessage("continue");
          this.logger.info(`Requested continuation after Cline task failure ${result.failureMarker}.`);
          continue;
        }
        if (this.scanner.enabled && this.scanner.detectTestTimeouts && item.kind !== "message" && result.status === "test_timeout") {
          item.lastTestTimeoutMarker = result.testTimeoutMarker;
          item.error = result.errorText;
          await this.persist();
          await this.adapter.sendMessage(testTimeoutFollowup(result.timedOutCommand));
          this.recordHistoryEvent({ type: "unresolved_test_timeout", source: "scanner", taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: { marker: result.testTimeoutMarker, command: result.timedOutCommand, error: result.errorText } });
          this.logger.info(`Completion blocked by unresolved test timeout ${result.testTimeoutMarker}.`);
          continue;
        }
        const completionAudit = this.scanner.enabled && this.scanner.detectIncompleteCompletions && item.kind !== "message" && result.status === "completed" ? auditCompletionReport(result.completionText, result.taskProgressText) : undefined;
        if (completionAudit?.requiresContinuation) {
          item.incompleteCompletionClaims = (item.incompleteCompletionClaims ?? (item.lastCompletionMarker ? 1 : 0)) + 1;
          item.lastCompletionMarker = result.completionMarker;
          await this.persist();
          const remainingSteps = extractRemainingSteps(result.completionText, result.taskProgressText);
          const followup = incompleteCompletionFollowup(item.incompleteCompletionClaims, remainingSteps);
          await this.adapter.sendMessage(followup);
          if (item.incompleteCompletionClaims > 1) {
            this.recordHistoryEvent({ type: "repeated_incomplete_completion_claim", source: "scanner", taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: { claimCount: item.incompleteCompletionClaims, reason: completionAudit.reason, completionMarker: result.completionMarker, remainingSteps } });
          }
          this.logger.info(`Mandatory completion audit retained Cline task ${result.sessionId}: ${completionAudit.reason}.`);
          continue;
        }
        if (this.scanner.enabled && this.scanner.implementAuditRecommendations && item.kind !== "message" && result.status === "completed") {
          const recommendations = extractAuditRecommendations(item.prompt, result.completionText);
          const handled = new Set(item.handledAuditRecommendationKeys ?? []);
          const unhandled = selectUnhandledAuditRecommendations(recommendations, [...handled]);
          if (unhandled.length) {
            item.lastCompletionMarker = result.completionMarker;
            item.handledAuditRecommendationKeys = [...handled, ...unhandled.map(recommendationKey)].slice(-100);
            await this.persist();
            await this.adapter.sendMessage(auditRecommendationFollowup(unhandled, this.scanner.requirePostImplementationReport));
            this.recordHistoryEvent({ type: "audit_recommendations_requested", source: "scanner", taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: { completionMarker: result.completionMarker, recommendations: unhandled, requirePostImplementationReport: this.scanner.requirePostImplementationReport } });
            this.logger.info(`Retained audit task ${result.sessionId} to implement ${unhandled.length} recommendation(s).`);
            continue;
          }
        }
        item.finishedAt = new Date().toISOString();
        item.state = result.status === "deleted" ? "skipped" : result.status === "completed" && (result.exitCode === undefined || result.exitCode === 0) ? "completed" : "failed";
        if (item.state === "failed") item.error = result.errorText ?? `Cline session ended with ${result.status}${result.exitCode === undefined ? "" : ` (exit ${result.exitCode})`}.`;
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
    this.recordHistory("queue_persisted");
  }

  private recordHistory(reason: string): void {
    if (!this.history) return;
    try { this.history.recordQueueSnapshot(this.workspace, this.data.items, reason, { paused: this.data.paused === true, ignoredWaitingTaskIds: this.data.ignoredWaitingTaskIds ?? [], compactedNewTaskMarkers: this.data.compactedNewTaskMarkers ?? [], handledNewTaskMarkers: this.data.handledNewTaskMarkers ?? [] }); }
    catch (error) { this.logger.error(`Failed to record SQLite history snapshot: ${String(error)}`); }
  }

  private recordHistoryEvent(event: Parameters<HistoryStore["recordEvent"]>[1]): void {
    if (!this.history) return;
    try { this.history.recordEvent(this.workspace, event); }
    catch (error) { this.logger.error(`Failed to record SQLite history event: ${String(error)}`); }
  }

  async stop(): Promise<void> { this.abortController.abort(); await Promise.all([this.worker, this.policyWorker]); }
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function remainingTaskDispatchDelay(items: Array<{ kind?: "task" | "message"; state: string; finishedAt?: string }>, now = Date.now(), delayMs = TASK_DISPATCH_DELAY_MS): number {
  const latest = items
    .filter(item => item.kind !== "message" && (item.state === "completed" || item.state === "failed") && item.finishedAt)
    .map(item => Date.parse(item.finishedAt!))
    .filter(Number.isFinite)
    .reduce((maximum, value) => Math.max(maximum, value), 0);
  return latest ? Math.max(0, latest + delayMs - now) : 0;
}

export function incompleteCompletionFollowup(claimCount: number, remainingSteps: string[] = []): string {
  const exactItems = remainingSteps.length
    ? `\n\nThe scanner detected these concrete remaining steps:\n${remainingSteps.map((item, index) => `${index + 1}. ${JSON.stringify(item)}`).join("\n")}\n\nResolve each named item directly. If an incomplete item claims it is COMPLETED, resolve the contradiction by verifying the implementation and evidence, then accurately mark it complete or remove the unsupported claim.`
    : "";
  if (claimCount <= 1) return `Complete all unfinished work.${exactItems}\n\nReview the original task and your completion report, implement every remaining, pending, deferred, future, incomplete, or unvalidated item, and do not complete again until the entire requested scope is finished and validated.`;
  return `STOP: you have repeatedly claimed completion while the completion audit still finds incomplete steps. Stay in this same task and do not provide another completion summary yet.${exactItems}\n\nRe-read the complete original task prompt. Rebuild task_progress from the full original scope rather than the shortened checklist: create a stage-by-stage requirements matrix covering every original implementation, architecture, integration, security, persistence, concurrency, serialization, observability, validation, audit/remediation, documentation, and completion criterion. For every requirement, record PASS with concrete file or command evidence, or implement and validate the missing work. Do not call attempt_completion while any checkbox is unchecked, any requirement lacks evidence, or any requested validation remains unrun without an explicit justified blocker.`;
}

export function testTimeoutFollowup(command?: string): string {
  const exactCommand = command ? `\n\nTimed-out test command:\n${JSON.stringify(command)}` : "";
  return `Do not complete the task: a test command timed out and the timeout is unresolved.${exactCommand}\n\nDiagnose whether the hang is in the production code, test fixture, teardown, background worker, async task, subprocess, or test runner. Improve the tests so every potentially blocking operation has a justified bounded timeout and cleanup path, and add or strengthen a regression test that reproduces the hang without leaving processes or threads behind. Then rerun the timed-out test scope (not merely a narrower substitute) and provide explicit passing output. If the original scope is inherently long-running, use an explicit justified outer timeout and progress evidence; do not reinterpret a timeout as a pass.`;
}

export function auditRecommendationFollowup(recommendations: string[], requireReport = true): string {
  const items = recommendations.map((item, index) => `${index + 1}. ${JSON.stringify(item)}`).join("\n");
  const report = requireReport
    ? " After implementation and validation, create a durable post-remediation report describing each recommendation, the change made, validation evidence, residual risk, and any justified blocker."
    : "";
  return `This task is an audit and its completion report contains actionable recommendations. Do not start a new task and do not stop at recommendations. Implement the following recommendations in this same task within the current workspace:\n${items}\n\nValidate every implemented recommendation and accurately report any item that requires unavailable authority or cannot be completed safely.${report} Do not claim completion until this remediation work is finished.`;
}

export function newTaskHandoffFollowup(proposedContext?: string): string {
  const context = proposedContext?.trim() ? `\n\nCline proposed this handoff context. Treat it as remaining work in this thread:\n${proposedContext.trim()}` : "";
  return `Do not start or spawn a new task. Continue the current original task in this exact same Cline thread. Finish all remaining work, including implementation, tests, validation, remediation, documentation, and the final task report.${context}\n\nDo not request another new task. Continue until every in-scope completion criterion from the original prompt and this handoff context is satisfied.`;
}

export function selectUnhandledAuditRecommendations(recommendations: string[], handledKeys: string[]): string[] {
  const handled = new Set(handledKeys);
  return recommendations.filter(recommendation => !handled.has(recommendationKey(recommendation)));
}

function recommendationKey(recommendation: string): string {
  return recommendation.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
