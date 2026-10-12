import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ClineConsoleError } from "../common/errors";
import { taskTitle } from "../common/task_title";
import type { Logger } from "../common/logging";
import type { ClineAdapter } from "../integrations/cline/types";
import type { QueueStatus, TokenUsage } from "../ipc/types";
import { getLatestLegacyWorkspaceTaskPrompt, getLegacyNewTaskHandoff, getLegacyWorkspaceSessionStatus, getOwnedLegacyTaskActivity, SAME_THREAD_ACK_MARKER, type WorkspaceActivity, waitForLegacyMessageCompletion, waitForLegacyNewTaskHandoffAcknowledgement, waitForLegacyTaskCompletion, waitForLegacyWorkspaceIdle, waitForLegacyWorkspaceIdleStability } from "../integrations/cline/completion_monitor";
import { auditCompletionReport, extractAuditRecommendations, extractRemainingSteps } from "../integrations/cline/remaining_work";
import type { HistoryStore } from "../history/history_store";
import { writeYoloRestartRequest } from "../service/restart_request";
import { runtimeDirectory } from "./workspace_registry";
import { queueStateTransition, type PersistentQueueState } from "./task_flow";
import { checkTaskSupervision, generateSupervisionReport, enforceGitCommit, getChangedFiles, generateCommitMessage, type TaskSupervisionOptions } from "./task_supervision";

// Re-export types for convenience
export type { PersistentQueueState };

export interface PendingRecoveryContinuation { kind: "context_overflow" | "task_failure"; marker: string; sessionId: string; message: string; }
export interface QueueItem { id: string; kind?: "task" | "message"; sourcePath: string; prompt: string; reflective?: boolean; scopePath?: string; reflectionRequested?: boolean; completionVerificationRequested?: boolean; completionVerificationRounds?: number; userConfirmedCompletion?: boolean; targetSessionId?: string; resumeSessionId?: string; state: PersistentQueueState; queuedAt: string; dispatchedAt?: string; finishedAt?: string; activeMs?: number; activeSince?: string; sessionId?: string; lastCompletionMarker?: string; lastRecoveryMarker?: string; lastFailureMarker?: string; lastYoloRestartMarker?: string; lastYoloFreshRecoveryMarker?: string; lastYoloRestartAt?: string; yoloRestartCount?: number; lastTestTimeoutMarker?: string; lastScopeViolationMarker?: string; pendingRecoveryContinuation?: PendingRecoveryContinuation; modelConflict?: { winnerWorkspace: string; modelIdentity: string; interruptedAt: string }; incompleteCompletionClaims?: number; unchangedCompletionCorrectionRounds?: number; stuckLoopRounds?: number; handledAuditRecommendationKeys?: string[]; error?: string; }
interface QueueFile { version: 1; workspace: string; recoveryProtocolVersion?: 1; timingVersion?: 4; timingResetAt?: string; paused?: boolean; ignoredWaitingTaskIds?: string[]; compactedNewTaskMarkers?: string[]; handledNewTaskMarkers?: string[]; ownedSessionIds?: string[]; tokenUsageBySession?: Record<string, TokenUsage>; items: QueueItem[]; }
export const TASK_DISPATCH_DELAY_MS = 15_000;
export const DISPATCH_STABILITY_DELAY_MS = 1_000;
export const POLICY_MESSAGE_TIMEOUT_MS = 30_000;
export const QUEUE_WORKER_RETRY_DELAY_MS = 5_000;
export const MAX_HISTORY_SNAPSHOT_PROMPT_BYTES = 8 * 1024 * 1024;

export interface TaskScannerOptions {
  enabled: boolean;
  terminalStabilityMs: number;
  interTaskDelayMs: number;
  detectIncompleteCompletions: boolean;
  maxUnchangedCompletionCorrectionRounds: number;
  detectTestTimeouts: boolean;
  implementAuditRecommendations: boolean;
  requirePostImplementationReport: boolean;
  verifyCompletionCriteria: boolean;
  completionConfidenceThreshold: number;
  maxCompletionVerificationRounds: number;
  reflective: boolean;
  restartOnYoloFailure: boolean;
  detectStuckLoops: boolean;
  maxStuckLoopRounds: number;
  waitForLmStudio: boolean;
  lmStudioHost: string;
  lmStudioPort: number;
  singleQueuePerLmStudioModel: boolean;
}

export const DEFAULT_TASK_SCANNER_OPTIONS: TaskScannerOptions = {
  enabled: true,
  terminalStabilityMs: 15_000,
  interTaskDelayMs: 15_000,
  detectIncompleteCompletions: true,
  maxUnchangedCompletionCorrectionRounds: 5,
  detectTestTimeouts: true,
  implementAuditRecommendations: true,
  requirePostImplementationReport: true,
  verifyCompletionCriteria: true,
  completionConfidenceThreshold: 90,
  maxCompletionVerificationRounds: 3,
  reflective: false,
  restartOnYoloFailure: true,
  detectStuckLoops: true,
  maxStuckLoopRounds: 3,
  waitForLmStudio: true,
  lmStudioHost: "127.0.0.1",
  lmStudioPort: 1234,
  singleQueuePerLmStudioModel: true
};

export function queueResumeContinuationRequired(activity: WorkspaceActivity | undefined, runningSessionId?: string): activity is WorkspaceActivity & { sessionId: string } {
  return activity?.status === "waiting"
    && typeof activity.sessionId === "string"
    && activity.sessionId.length > 0
    && (!runningSessionId || activity.sessionId === runningSessionId);
}

export function terminalQueueRemovalAllowed(activity: WorkspaceActivity | undefined): activity is WorkspaceActivity & { sessionId: string } {
  return typeof activity?.sessionId === "string"
    && activity.sessionId.length > 0
    && (activity.status === "failed" || activity.status === "completed" || activity.status === "idle");
}

export function sessionReplacementAllowed(currentSessionId: string | undefined, observedSessionId: string): boolean {
  if (!currentSessionId || currentSessionId === observedSessionId) return true;
  if (/^\d+$/.test(currentSessionId) && /^\d+$/.test(observedSessionId)) {
    return BigInt(observedSessionId) >= BigInt(currentSessionId);
  }
  return true;
}

export class TaskQueue {
  private data: QueueFile;
  private worker?: Promise<void>;
  private policyWorker?: Promise<void>;
  private deliveryChain: Promise<void> = Promise.resolve();
  private persistenceChain: Promise<void> = Promise.resolve();
  private abortController = new AbortController();
  private restartRecoveryPending = false;
  private lastTokenUsagePersistAt = 0;
  private largeSnapshotSuppressionLogged = false;
  private writerLeaseLossLogged = false;

  constructor(private readonly file: string, private readonly workspace: string, private readonly adapter: ClineAdapter, private readonly logger: Logger, private readonly history?: HistoryStore, private readonly scanner: TaskScannerOptions = DEFAULT_TASK_SCANNER_OPTIONS, private readonly cleanupTerminals?: () => Promise<void>, private readonly waitForBackend?: (signal: AbortSignal) => Promise<void>, private readonly ownsWriterLease?: () => Promise<boolean>) {
    this.data = { version: 1, workspace, items: [] };
  }

  async start(): Promise<void> {
    if (this.abortController.signal.aborted) this.abortController = new AbortController();
    await this.load();
    // An extension or OS restart is an interruption. Never charge the offline
    // interval to active execution; the first fresh running observation resumes it.
    let timingChanged = false;
    if (this.data.timingVersion !== 4) {
      this.data.timingVersion = 4;
      this.data.timingResetAt = new Date().toISOString();
      timingChanged = true;
      this.logger.info(`Queue timing baseline reset for ${this.workspace}; future averages use only newly completed tasks.`);
    }
    for (const item of this.data.items) {
      if (item.state === "running" && item.activeSince !== undefined) {
        item.activeSince = undefined;
        timingChanged = true;
      }
    }
    // Recover the dispatch exemption when the extension/daemon restarted
    // after a queue item was finalized but before Cline refreshed its latest
    // workspace-session metadata.  Without this, a stale `running` record for
    // the completed head permanently blocks the next queued item.
    if (!this.data.items.some(item => item.state === "running")
      && this.data.items.some(item => item.state === "queued")) {
      const latestFinalizedSession = this.data.items
        .filter(item => item.state === "completed" && item.sessionId && item.finishedAt)
        .sort((left, right) => Date.parse(right.finishedAt!) - Date.parse(left.finishedAt!))[0]
        ?.sessionId;
      if (latestFinalizedSession) {
        this.rememberDispatchExemption(latestFinalizedSession);
        timingChanged = true;
      }
    }
    if (timingChanged) await this.persist();
    await this.migrateRecoveryProtocol();
    this.restartRecoveryPending = this.data.paused !== true && this.data.items.some(item => item.state === "queued" || item.state === "running");
    this.recordHistory("startup_reconciliation");
    this.kick();
    this.startPolicyMonitor();
  }

  async enqueue(tasks: Array<{ sourcePath: string; prompt: string; reflective?: boolean; scopePath?: string }>, allowDuplicates = false, freshOnInterrupted = false, force = false): Promise<{ queued: number; queueLength: number; interruptedOverridden?: boolean }> {
    // Force mode: always override current running task (like -f but regardless of state)
    if (force && this.data.items.some(item => item.state === "running")) return this.overrideInterrupted(tasks);
    if (freshOnInterrupted && this.data.items.some(item => item.state === "running")) return this.overrideInterrupted(tasks);
    if (!allowDuplicates) {
      const activeSources = new Set(this.data.items.filter(item => item.state === "running" || item.state === "queued").map(item => item.sourcePath));
      const seen = new Set<string>();
      const duplicates = [...new Set(tasks.flatMap(task => {
        const duplicate = activeSources.has(task.sourcePath) || seen.has(task.sourcePath);
        seen.add(task.sourcePath);
        return duplicate ? [task.sourcePath] : [];
      }))];
      if (duplicates.length) throw new ClineConsoleError("DUPLICATE_QUEUE_TASK", `The following task source is already active or duplicated in this batch:\n${duplicates.map(sourcePath => `  - ${sourcePath}`).join("\n")}`);
    }
    return this.append(tasks.map(task => ({ kind: "task" as const, sourcePath: task.sourcePath, prompt: task.prompt, reflective: task.reflective, scopePath: task.scopePath })));
  }

  private async overrideInterrupted(tasks: Array<{ sourcePath: string; prompt: string; reflective?: boolean; scopePath?: string }>): Promise<{ queued: number; queueLength: number; interruptedOverridden: true }> {
    this.abortController.abort();
    await Promise.all([this.worker, this.policyWorker]);
    this.abortController = new AbortController();
    const interrupted = this.data.items.find(item => item.state === "running");
    if (!interrupted) return { ...(await this.enqueue(tasks)), interruptedOverridden: true };
    this.pauseTaskTimer(interrupted);
    interrupted.state = queueStateTransition(interrupted.state, "skipped");
    interrupted.finishedAt = new Date().toISOString();

    // Generate a more contextual error message based on the task content
    const interruptedTitle = firstLine(interrupted.prompt);
    const forceOverrideMessage = this.generateForceOverrideMessage(tasks[0]?.prompt || "", interrupted.prompt);
    interrupted.error = `Interrupted queue task explicitly overridden by queue add --force; replacement starts from scratch. ${forceOverrideMessage}`;

    const now = new Date().toISOString();
    const replacements: QueueItem[] = tasks.map(task => ({ id: randomUUID(), kind: "task", ...task, state: "queued", queuedAt: now }));
    const terminal = this.data.items.filter(item => item.state === "completed" || item.state === "failed" || item.state === "skipped").slice(-100);
    const waiting = this.data.items.filter(item => item.state === "queued");
    this.data.items = [...terminal, ...replacements, ...waiting];
    await this.persist();
    this.recordHistoryEvent({ type: "interrupted_task_overridden", source: "cli", observed: true, taskId: interrupted.id, queueItemId: interrupted.id, clineSessionId: interrupted.sessionId, payload: { sourcePath: interrupted.sourcePath, replacements: replacements.map(item => ({ id: item.id, sourcePath: item.sourcePath })) } });
    this.logger.info(`Interrupted queue item ${interrupted.id} (${interruptedTitle}) overridden by ${tasks.length} fresh task(s) for ${this.workspace}.`);
    this.kick();
    this.startPolicyMonitor();
    return { queued: tasks.length, queueLength: this.data.items.filter(item => item.state === "queued" || item.state === "running").length, interruptedOverridden: true };
  }

  private generateForceOverrideMessage(newTaskPrompt: string, interruptedPrompt: string): string {
    // Extract key information from both prompts to create a contextual message
    const newFirstLine = firstLine(newTaskPrompt);
    const oldFirstLine = firstLine(interruptedPrompt);

    if (!newTaskPrompt.trim() || !interruptedPrompt.trim()) return "New task content could not be analyzed.";

    // Check for overlapping task scope
    const overlapPatterns = [
      /implement\s+(?:the\s+)?(?:same|corresponding)/i,
      /complete\s+(?:the\s+)?(?:remaining|outstanding|pending|unfinished|leftover)/i,
      /continue\s+(?:with|from where you left off)|resume/i,
      /\bfix\b.*\bbug/i
    ];

    let analysis = [];

    // Check if new task is a continuation
    if (overlapPatterns.some(p => p.test(newTaskPrompt))) {
      analysis.push("New task appears to be a continuation of the interrupted work.");
    }

    // Compare task scope
    const newScopeMatch = newTaskPrompt.match(/(?:task|scope|project)\s*[:\s]+([^\n]+)/i);
    const oldScopeMatch = interruptedPrompt.match(/(?:task|scope|project)\s*[:\s]+([^\n]+)/i);

    if (newScopeMatch && oldScopeMatch) {
      const newScope = newScopeMatch[1].trim();
      const oldScope = oldScopeMatch[1].trim();
      if (newScope === oldScope) {
        analysis.push("New task has the same scope as the interrupted task.");
      } else {
        analysis.push(`Task scope changed: "${oldFirstLine}" → "${newFirstLine}".`);
      }
    }

    // Check for completion status
    const newComplete = /(?:complete|done|finished)\s+the\s+(?:task|work)/i.test(newTaskPrompt);
    if (newComplete) {
      analysis.push("New task explicitly requests task completion.");
    }

    return analysis.length > 0 ? `Override analysis: ${analysis.join(" ")}` : "Replacement task queued immediately.";
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

  async confirmCompletion(): Promise<{ completed: boolean; id: string; title: string; queueLength: number }> {
    this.abortController.abort();
    await Promise.all([this.worker, this.policyWorker]);
    this.abortController = new AbortController();
    const item = this.data.items.find(candidate => candidate.kind !== "message" && candidate.state === "running");
    if (!item) {
      this.startPolicyMonitor();
      throw new ClineConsoleError("NO_RUNNING_QUEUE_TASK", "No running queue task is available for user-confirmed completion.");
    }
    this.pauseTaskTimer(item);
    item.userConfirmedCompletion = true;
    item.state = queueStateTransition(item.state, "completed");
    item.finishedAt = new Date().toISOString();
    item.error = undefined;
    await this.persist();
    this.recordHistoryEvent({ type: "user_confirmed_completion", source: "cli", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: item.sessionId, payload: { sourcePath: item.sourcePath } });
    this.logger.info(`User confirmed completion of queue item ${item.id}.`);
    const result = { completed: true as const, id: item.id, title: firstLine(item.prompt), queueLength: this.data.items.filter(candidate => candidate.state === "queued" || candidate.state === "running").length };
    await this.resetFinishedQueueLifecycle();
    this.kick();
    this.startPolicyMonitor();
    return result;
  }

  async replace(tasks: Array<{ sourcePath: string; prompt: string; reflective?: boolean; scopePath?: string }>): Promise<{ queued: number; replaced: number; queueLength: number }> {
    const replaced = this.data.items.filter(item => item.state === "queued").length;
    const retained = this.data.items.filter(item => item.state !== "queued");
    const now = new Date().toISOString();
    this.data.items = [...retained, ...tasks.map(task => ({ id: randomUUID(), kind: "task" as const, sourcePath: task.sourcePath, prompt: task.prompt, reflective: task.reflective, scopePath: task.scopePath, state: "queued" as const, queuedAt: now }))];
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
    // Clearing is a fresh queue lifecycle.  Retaining a previous pause makes
    // subsequently enqueued work appear healthy while it can never dispatch.
    this.data.paused = false;
    this.data.compactedNewTaskMarkers = [];
    this.data.handledNewTaskMarkers = [];
    this.resetLifecycleCounters();
    await this.persist();
    const runningPreserved = false;
    const cleared = clearedWaiting + clearedStaleRunning;
    this.logger.info(`Enforced queue clearance for ${this.workspace}: ${clearedWaiting} waiting, ${clearedStaleRunning} running, ${historyDeleted} Cline history task(s).`);
    this.startPolicyMonitor();
    return { cleared, clearedWaiting, clearedStaleRunning, queueLength: 0, runningPreserved, historyDeleted };
  }

  async pop(selector: string, resolvedSelector?: string, selectorType?: "file" | "title" | "id"): Promise<{ removed: boolean; id: string; title: string; sourcePath: string; queueLength: number }> {
    const active = this.data.items.filter(item => item.state === "running" || item.state === "queued");
    const position = /^(?:0|[1-9]\d*)$/.test(selector) ? Number(selector) : undefined;
    const positionedItem = position === undefined || position < 1 ? undefined : active[position - 1];
    const waiting = active.filter(item => item.state === "queued");
    const idMatches = selectorType === "file" || selectorType === "title" ? [] : waiting.filter(item => item.id === selector);
    const positionMatches = idMatches.length || selectorType === "file" || selectorType === "title" || positionedItem?.state !== "queued" ? [] : [positionedItem];
    const pathMatches = idMatches.length || positionMatches.length || selectorType === "id" || selectorType === "title" ? [] : waiting.filter(item => item.sourcePath === selector || (resolvedSelector !== undefined && item.sourcePath === resolvedSelector));
    const titleMatches = idMatches.length || positionMatches.length || pathMatches.length || selectorType === "id" || selectorType === "file" ? [] : waiting.filter(item => firstLine(item.prompt) === selector);
    let matches = idMatches.length ? idMatches : positionMatches.length ? positionMatches : pathMatches.length ? pathMatches : titleMatches;
    const selectedRunning = positionedItem?.state === "running" && (selectorType === undefined || selectorType === "id")
      ? positionedItem
      : this.data.items.find(item => item.state === "running" && (item.id === selector || item.sourcePath === selector || item.sourcePath === resolvedSelector || firstLine(item.prompt) === selector));
    if (!matches.length && selectedRunning) {
      const activity = await getOwnedLegacyTaskActivity(this.data.ownedSessionIds ?? [], selectedRunning.prompt, undefined, selectedRunning.dispatchedAt);
      if (!terminalQueueRemovalAllowed(activity)) {
        throw new ClineConsoleError("QUEUE_ITEM_RUNNING", `Queue position ${position ?? 1} is currently running and cannot be removed.`);
      }
      matches = [selectedRunning];
    }
    if (!matches.length) {
      throw new ClineConsoleError("QUEUE_ITEM_NOT_FOUND", "No waiting queue item matches that position, queue ID, file path, or displayed title.");
    }
    if (matches.length > 1) throw new ClineConsoleError("QUEUE_ITEM_AMBIGUOUS", "Multiple waiting queue items have that displayed title; use the file path or queue ID instead.");
    const [item] = matches;
    if (item.state === "running") {
      this.abortController.abort();
      await Promise.all([this.worker, this.policyWorker]);
      this.abortController = new AbortController();
      this.pauseTaskTimer(item);
      this.rememberDispatchExemption(item.sessionId);
    }
    const removedPosition = this.data.items.findIndex(candidate => candidate.id === item.id) + 1;
    this.data.items = this.data.items.filter(candidate => candidate.id !== item.id);
    await this.persist(false);
    if (this.history) {
      try { this.history.recordQueueRemove(this.workspace, item.id, removedPosition); }
      catch (error) { this.logger.error(`Failed to record incremental SQLite queue removal: ${String(error)}`); }
    }
    const queueLength = this.data.items.filter(candidate => candidate.state === "queued" || candidate.state === "running").length;
    this.logger.info(`Removed ${item.state === "running" ? "terminal reconciled" : "waiting"} queue item ${item.id} from ${this.workspace}.`);
    this.kick();
    this.startPolicyMonitor();
    return { removed: true, id: item.id, title: firstLine(item.prompt), sourcePath: item.sourcePath, queueLength };
  }

  async trim(keep: number): Promise<{ trimmed: number; kept: number; queueLength: number }> {
    if (!Number.isSafeInteger(keep) || keep < 1) throw new ClineConsoleError("INVALID_ARGUMENT", "queue trim requires a positive integer.");
    const active = this.data.items.filter(item => item.state === "running" || item.state === "queued");
    const removed = active.slice(keep).filter(item => item.state === "queued");
    if (!removed.length) return { trimmed: 0, kept: Math.min(keep, active.length), queueLength: active.length };
    const removedIds = new Set(removed.map(item => item.id));
    this.data.items = this.data.items.filter(item => !removedIds.has(item.id));
    await this.persist(false);
    if (this.history) {
      try { this.history.recordQueueTrim(this.workspace, [...removedIds], keep); }
      catch (error) { this.logger.error(`Failed to record incremental SQLite queue trim: ${String(error)}`); }
    }
    const queueLength = this.data.items.filter(item => item.state === "queued" || item.state === "running").length;
    this.logger.info(`Trimmed ${removed.length} waiting queue item(s) from ${this.workspace}; retained the first ${keep} active item(s).`);
    return { trimmed: removed.length, kept: Math.min(keep, active.length), queueLength };
  }

  async skipWaitingTask(sessionId: string): Promise<{ skipped: boolean; sessionId: string }> {
    this.rememberDispatchExemption(sessionId);
    await this.persist();
    this.logger.info(`Marked incomplete Cline task ${sessionId} as skipped for queue dispatch in ${this.workspace}.`);
    return { skipped: true, sessionId };
  }

  private rememberDispatchExemption(sessionId: string | undefined): void {
    if (!sessionId) return;
    const ignored = new Set(this.data.ignoredWaitingTaskIds ?? []);
    ignored.add(sessionId);
    this.data.ignoredWaitingTaskIds = [...ignored].slice(-20);
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
    const running = this.data.items.find(item => item.kind !== "message" && item.state === "running");
    if (running) {
      try {
        const activity = await this.currentOwnedActivity();
        if (queueResumeContinuationRequired(activity, running.sessionId)) {
          await this.sendToOwnedSession(activity.sessionId, "Continue the current task from where it was interrupted. Stay in this same Cline thread, complete the full original scope, and validate it before completing.", "queue resume continuation");
          this.recordHistoryEvent({ type: "queue_waiting_task_resumed", source: "cline-console", observed: true, taskId: running.id, queueItemId: running.id, clineSessionId: activity.sessionId, payload: { reason: "queue resume observed Cline Resume Task state" } });
          this.logger.info(`Queue resume continued waiting Cline session ${activity.sessionId} for ${this.workspace}.`);
        }
      } catch (error) {
        if (/task not found/i.test(String(error))) {
          const fallback = await getOwnedLegacyTaskActivity(this.data.ownedSessionIds ?? [], running.prompt, undefined, running.dispatchedAt);
          if (fallback?.sessionId && fallback.sessionId !== running.sessionId) {
            const orphanedSessionId = running.sessionId;
            running.sessionId = fallback.sessionId;
            await this.persist();
            this.recordHistoryEvent({ type: "queue_orphaned_session_reconciled", source: "cline-console", observed: true, taskId: running.id, queueItemId: running.id, clineSessionId: fallback.sessionId, payload: { orphanedSessionId, fallbackStatus: fallback.status, reason: "Cline rejected the newer persisted session as Task not found" } });
            this.logger.info(`Reconciled orphaned Cline session ${orphanedSessionId ?? "unbound"} to available owned session ${fallback.sessionId} (${fallback.status ?? "unknown"}).`);
            this.kick();
            return { resumed: true, queueLength };
          }
        }
        this.logger.error(`Queue resume could not continue the waiting Cline task for ${this.workspace}: ${String(error)}`);
      }
    }
    if (queueLength) this.kick();
    this.logger.info(`Queue resume requested for ${this.workspace}; active item count=${queueLength}.`);
    return { resumed: queueLength > 0, queueLength };
  }

  async continueCurrent(): Promise<{ continued: boolean; queueLength: number; sessionId?: string }> {
    this.data.paused = false;
    await this.persist();
    const queueLength = this.data.items.filter(item => item.state === "queued" || item.state === "running").length;
    const running = this.data.items.find(item => item.kind !== "message" && item.state === "running");
    if (!running) {
      if (queueLength) this.kick();
      return { continued: queueLength > 0, queueLength };
    }
    const activity = await this.currentOwnedActivity();
    if (activity?.sessionId && (activity.status === "waiting" || activity.status === "completed" || activity.status === "idle" || activity.status === "failed")) {
      await this.sendToOwnedSession(activity.sessionId, "Please continue the current task from where it stopped. Remain in this task thread and complete any outstanding original requirements.", "gentle queue continuation");
      this.recordHistoryEvent({ type: "queue_continuation_requested", source: "cline-console", observed: true, taskId: running.id, queueItemId: running.id, clineSessionId: activity.sessionId });
    }
    this.kick();
    return { continued: true, queueLength, ...(activity?.sessionId ? { sessionId: activity.sessionId } : {}) };
  }

  async relaunchCurrent(): Promise<{ relaunched: boolean; queueLength: number; previousSessionId?: string; sessionId?: string }> {
    this.data.paused = false;
    const queueLength = this.data.items.filter(item => item.state === "queued" || item.state === "running").length;
    const item = this.data.items.find(candidate => candidate.kind !== "message" && candidate.state === "running");
    if (!item) {
      await this.persist();
      if (queueLength) this.kick();
      return { relaunched: false, queueLength };
    }
    const previousSessionId = item.sessionId;
    const started = await this.adapter.newTask(item.prompt);
    let sessionId = started.taskId;
    const deadline = Date.now() + POLICY_MESSAGE_TIMEOUT_MS;
    while (!sessionId && Date.now() < deadline && !this.abortController.signal.aborted) {
      const latest = await getLatestLegacyWorkspaceTaskPrompt(this.workspace);
      if (latest?.sessionId !== previousSessionId && latest?.prompt === item.prompt) sessionId = latest.sessionId;
      if (!sessionId) await abortableDelay(250, this.abortController.signal);
    }
    if (!sessionId) throw new ClineConsoleError("RELAUNCH_FAILED", `Relaunched task did not expose a session ID within ${POLICY_MESSAGE_TIMEOUT_MS}ms.`);
    item.sessionId = sessionId;
    item.dispatchedAt = new Date().toISOString();
    item.activeMs = 0;
    item.activeSince = item.dispatchedAt;
    item.finishedAt = undefined;
    item.pendingRecoveryContinuation = undefined;
    item.lastCompletionMarker = undefined;
    item.lastRecoveryMarker = undefined;
    item.lastFailureMarker = undefined;
    item.lastTestTimeoutMarker = undefined;
    item.lastScopeViolationMarker = undefined;
    item.completionVerificationRequested = undefined;
    item.completionVerificationRounds = 0;
    item.reflectionRequested = undefined;
    item.userConfirmedCompletion = undefined;
    item.incompleteCompletionClaims = 0;
    item.unchangedCompletionCorrectionRounds = 0;
    item.stuckLoopRounds = 0;
    item.modelConflict = undefined;
    item.error = undefined;
    if (!(this.data.ownedSessionIds ?? []).includes(sessionId)) this.data.ownedSessionIds = [...(this.data.ownedSessionIds ?? []).slice(-199), sessionId];
    await this.persist();
    this.recordHistoryEvent({ type: "queue_task_relaunched", source: "cline-console", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: sessionId, payload: { previousSessionId } });
    this.kick();
    return { relaunched: true, queueLength, previousSessionId, sessionId };
  }

  getStatus(): QueueStatus {
    return buildQueueStatus(this.workspace, this.data.items, this.data.paused === true, this.data.timingResetAt);
  }

  getEnqueueContext(): { active: boolean; sessionId?: string; status: "running" | "idle" } {
    const current = this.data.items.find(item => item.state === "running");
    return current ? { active: true, sessionId: current.sessionId, status: "running" } : { active: false, status: "idle" };
  }

  lmStudioArbitration(): { enabled: boolean; host: string; port: number } {
    return { enabled: this.scanner.singleQueuePerLmStudioModel, host: this.scanner.lmStudioHost, port: this.scanner.lmStudioPort };
  }

  async currentOwnedActivity(): Promise<WorkspaceActivity | undefined> {
    const item = this.data.items.find(candidate => candidate.kind !== "message" && candidate.state === "running");
    if (!item) return undefined;
    const activity = await getOwnedLegacyTaskActivity(this.data.ownedSessionIds ?? [], item.prompt, undefined, item.dispatchedAt);
    if (!activity?.sessionId || activity.sessionId === item.sessionId) return activity;
    if (!sessionReplacementAllowed(item.sessionId, activity.sessionId)) {
      const current = await getLegacyWorkspaceSessionStatus(this.workspace);
      if (!current || current.sessionId !== item.sessionId) return undefined;
      const status = (["running", "waiting", "idle", "completed", "failed"] as const).find(value => value === current.status) ?? "idle";
      return { active: status === "running" || status === "waiting", sessionId: current.sessionId, status, observedAt: current.observedAt };
    }
    const previousSessionId = item.sessionId;
    item.sessionId = activity.sessionId;
    await this.persist();
    this.recordHistoryEvent({
      type: "queue_session_reconciled",
      source: "cline-console",
      observed: true,
      taskId: item.id,
      queueItemId: item.id,
      clineSessionId: activity.sessionId,
      payload: { previousSessionId, reason: "newest owned exact-prompt UI transcript" }
    });
    this.logger.info(`Reconciled running queue item ${item.id} from stale session ${previousSessionId ?? "unbound"} to owned active session ${activity.sessionId}.`);
    return activity;
  }

  async pauseForModelConflict(sessionId: string, winnerWorkspace: string, modelIdentity: string): Promise<void> {
    const item = this.data.items.find(candidate => candidate.state === "running" && candidate.sessionId === sessionId);
    if (!item) throw new ClineConsoleError("QUEUE_ITEM_NOT_FOUND", "The model-conflict session is no longer the running queue item.");
    this.pauseTaskTimer(item);
    this.data.paused = true;
    item.modelConflict = { winnerWorkspace, modelIdentity, interruptedAt: new Date().toISOString() };
    item.error = `Interrupted because ${winnerWorkspace} resumed a queue task using the same LM Studio model (${modelIdentity}); the Cline task remains open for same-thread resume.`;
    await this.persist();
    this.recordHistoryEvent({ type: "lmstudio_model_preempted", source: "cline-console", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: sessionId, payload: { winnerWorkspace, modelIdentity, queuePaused: true } });
  }

  modelConflict(): { sessionId: string; winnerWorkspace: string; modelIdentity: string; interruptedAt: string } | undefined {
    const item = this.data.items.find(candidate => candidate.state === "running" && candidate.sessionId && candidate.modelConflict);
    return item?.sessionId && item.modelConflict ? { sessionId: item.sessionId, ...item.modelConflict } : undefined;
  }

  async resumeAfterModelConflict(sessionId: string, modelIdentity: string): Promise<{ resumed: true; queueLength: number }> {
    const item = this.data.items.find(candidate => candidate.state === "running" && candidate.sessionId === sessionId);
    if (!item?.modelConflict || item.modelConflict.modelIdentity !== modelIdentity) {
      throw new ClineConsoleError("MODEL_CONFLICT_NOT_FOUND", "The requested task is not the exact queue item interrupted for this LM Studio model.");
    }
    await this.sendToOwnedSession(sessionId, "Continue the current task from where it was interrupted by queue arbitration. Stay in this same Cline thread and complete the full original scope.", "model-conflict continuation");
    item.modelConflict = undefined;
    item.error = undefined;
    this.data.paused = false;
    await this.persist();
    this.kick();
    const queueLength = this.data.items.filter(candidate => candidate.state === "queued" || candidate.state === "running").length;
    this.recordHistoryEvent({ type: "lmstudio_model_restored", source: "cline-console", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: sessionId, payload: { modelIdentity, queuePaused: false } });
    return { resumed: true, queueLength };
  }

  getRetainedTokenUsage(): Map<string, TokenUsage> {
    return new Map(Object.entries(this.data.tokenUsageBySession ?? {}));
  }

  ownedSessionIds(): string[] {
    return [...new Set([...(this.data.ownedSessionIds ?? []), ...this.data.items.flatMap(item => item.sessionId ? [item.sessionId] : [])])];
  }

  async retainTokenUsage(live: ReadonlyMap<string, TokenUsage>): Promise<Map<string, TokenUsage>> {
    const retained = { ...(this.data.tokenUsageBySession ?? {}) };
    let changed = false;
    for (const [sessionId, usage] of live) {
      const previous = retained[sessionId];
      const next = previous ? {
        input: Math.max(previous.input, usage.input), output: Math.max(previous.output, usage.output),
        total: Math.max(previous.total, usage.total), cacheReads: Math.max(previous.cacheReads, usage.cacheReads),
        cacheWrites: Math.max(previous.cacheWrites, usage.cacheWrites), sessions: 1
      } : usage;
      if (JSON.stringify(previous) !== JSON.stringify(next)) { retained[sessionId] = next; changed = true; }
    }
    if (changed) {
      this.data.tokenUsageBySession = retained;
      const now = Date.now();
      if (now - this.lastTokenUsagePersistAt >= 60_000) {
        this.lastTokenUsagePersistAt = now;
        await this.persist(false);
      }
    }
    return new Map(Object.entries(retained));
  }

  ownsSession(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    return (this.data.ownedSessionIds ?? []).includes(sessionId) || this.data.items.some(item => item.sessionId === sessionId || item.resumeSessionId === sessionId || item.targetSessionId === sessionId);
  }

  async registerOwnedSession(sessionId: string): Promise<void> {
    if (this.ownsSession(sessionId)) return;
    this.data.ownedSessionIds = [...(this.data.ownedSessionIds ?? []).slice(-199), sessionId];
    await this.persist();
    this.recordHistoryEvent({ type: "cline_session_owned", source: "cline-console", observed: true, clineSessionId: sessionId });
  }

  async adoptReloadedSession(previousSessionId: string, reloadedSessionId: string, prompt?: string): Promise<void> {
    let item = this.data.items.find(candidate => candidate.state === "running" && candidate.sessionId === previousSessionId);
    if (!item && prompt && this.ownsSession(previousSessionId)) {
      const matching = this.data.items.filter(candidate => candidate.state === "running" && candidate.prompt === prompt && this.ownsSession(candidate.sessionId));
      if (matching.length === 1) item = matching[0];
    }
    if (!item) throw new ClineConsoleError("TASK_NOT_OWNED", "The reloaded session does not replace the running cline-console queue task.");
    if (!(this.data.ownedSessionIds ?? []).includes(reloadedSessionId)) {
      this.data.ownedSessionIds = [...(this.data.ownedSessionIds ?? []).slice(-199), reloadedSessionId];
    }
    item.sessionId = reloadedSessionId;
    item.pendingRecoveryContinuation = undefined;
    item.lastCompletionMarker = undefined;
    item.lastRecoveryMarker = undefined;
    item.lastFailureMarker = undefined;
    item.lastTestTimeoutMarker = undefined;
    item.error = undefined;
    await this.persist();
    this.recordHistoryEvent({ type: "queue_reloaded_session_adopted", source: "cline-console", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: reloadedSessionId, payload: { previousSessionId } });
    this.logger.info(`Queue item ${item.id} adopted reloaded Cline session ${reloadedSessionId} from ${previousSessionId}.`);
  }

  async sendOwnedMessage(sessionId: string, message: string, purpose = "user-requested message"): Promise<void> {
    await this.sendToOwnedSession(sessionId, message, purpose);
  }

  sourcePathForPrompt(prompt: string): string | undefined {
    return [...this.data.items].reverse().find(item => item.prompt === prompt)?.sourcePath;
  }

  private async append(items: Array<{ kind: "task" | "message"; sourcePath: string; prompt: string; reflective?: boolean; scopePath?: string; targetSessionId?: string; resumeSessionId?: string }>): Promise<{ queued: number; queueLength: number }> {
    const now = new Date().toISOString();
    const terminal = this.data.items.filter(item => item.state === "completed" || item.state === "failed" || item.state === "skipped").slice(-100);
    const active = this.data.items.filter(item => item.state === "queued" || item.state === "running");
    const appended = items.map(item => ({ id: randomUUID(), ...item, state: "queued" as const, queuedAt: now }));
    const positionOffset = terminal.length + active.length;
    this.data.items = [...terminal, ...active, ...appended];
    // The JSON file remains the atomic queue authority. SQLite history can be
    // updated incrementally because append never changes active ordering.
    await this.persist(false);
    if (this.history) {
      try { this.history.recordQueueAppend(this.workspace, appended, positionOffset); }
      catch (error) { this.logger.error(`Failed to record incremental queue append: ${String(error)}`); }
    }
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
        if (handoff && !this.ownsSession(handoff.sessionId)) {
          await abortableDelay(1_000, this.abortController.signal);
          continue;
        }
        if (handoff && !(this.data.handledNewTaskMarkers ?? []).includes(handoff.marker)) {
          const semanticKey = newTaskHandoffKey(handoff.sessionId, handoff.text);
          const handoffPolicy = newTaskHandoffPolicy(handoff.repeatCount, (this.data.compactedNewTaskMarkers ?? []).includes(semanticKey));
          if (handoffPolicy === "suppress") {
            this.data.handledNewTaskMarkers = [...(this.data.handledNewTaskMarkers ?? []).slice(-99), handoff.marker];
            await this.persist();
            this.recordHistoryEvent({ type: "repeated_new_task_handoff_suppressed", source: "scanner", observed: true, clineSessionId: handoff.sessionId, payload: { marker: handoff.marker, semanticKey, repeatCount: handoff.repeatCount } });
            this.logger.info(`Suppressed repeated new-task handoff ${handoff.marker} after same-thread circuit breaker ${semanticKey}.`);
            continue;
          }
          this.recordHistoryEvent({ type: "new_task_handoff_detected", source: "scanner", observed: true, clineSessionId: handoff.sessionId, payload: { marker: handoff.marker, semanticKey, repeatCount: handoff.repeatCount, proposedContext: handoff.text } });
          if (handoffPolicy === "compact") {
            this.data.compactedNewTaskMarkers = [...(this.data.compactedNewTaskMarkers ?? []).slice(-99), semanticKey];
            await this.persist();
            await this.sendToOwnedSession(handoff.sessionId, "/compact", "repeated new-task handoff compaction");
            this.recordHistoryEvent({ type: "repeated_new_task_handoff_compacted", source: "scanner", observed: true, clineSessionId: handoff.sessionId, payload: { marker: handoff.marker, semanticKey, repeatCount: handoff.repeatCount } });
            this.logger.info(`Compacted Cline task ${handoff.sessionId} after ${handoff.repeatCount} identical new-task handoffs.`);
            await waitForLegacyMessageCompletion(this.workspace, handoff.sessionId, this.abortController.signal, this.logger);
          }
          await this.sendToOwnedSession(handoff.sessionId, newTaskHandoffFollowup(handoff.text), "same-thread task completion request");
          const delivered = await waitForLegacyNewTaskHandoffAcknowledgement(handoff, this.abortController.signal);
          if (!delivered) throw new Error(`Cline did not record the same-thread continuation for ${handoff.marker}; delivery will be retried.`);
          this.data.handledNewTaskMarkers = [...(this.data.handledNewTaskMarkers ?? []).slice(-99), handoff.marker];
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
     if (this.scanner.waitForLmStudio) await this.waitForBackend?.(this.abortController.signal);
     if (this.restartRecoveryPending) {
       let interrupted = this.data.items.find(item => item.state === "running");
       if (interrupted && !interrupted.sessionId) {
         this.logger.info(`Persisted queue recovered for ${this.workspace}; waiting for ${this.scanner.interTaskDelayMs}ms of stable Cline idle before requeueing an unbound dispatch.`);
         await waitForLegacyWorkspaceIdleStability(this.workspace, this.scanner.interTaskDelayMs, this.abortController.signal, this.logger, undefined,
           sessionId => (this.data.ignoredWaitingTaskIds ?? []).includes(sessionId));
         if (this.abortController.signal.aborted || this.data.paused) return;
         interrupted.state = queueStateTransition(interrupted.state, "queued");
         interrupted.dispatchedAt = undefined;
         await this.persist();
         this.recordHistoryEvent({ type: "queue_restart_recovered", source: "cline-console", taskId: interrupted.id, queueItemId: interrupted.id, payload: { undiscoveredDispatchRequeued: true, idleStabilityMs: this.scanner.interTaskDelayMs } });
       }
       if (interrupted?.sessionId) {
         if (await this.requestYoloRestartIfRequired(interrupted)) return;
         if (yoloFreshRecoveryRequired(interrupted.lastYoloRestartMarker, interrupted.lastYoloFreshRecoveryMarker)) {
           await this.restartYoloTaskFresh(interrupted, interrupted.lastYoloRestartMarker!);
         }
         let observed = await getLegacyWorkspaceSessionStatus(this.workspace);
         if (restartRecoveryDisposition(interrupted.sessionId, observed) === "complete") {
           // A completion_result is evidence for the scanner, not permission
           // to bypass its audit/verification/reflection pipeline.  Let the
           // normal monitor consume it after startup; otherwise a transient
           // companion restart can create a premature timing sample.
           this.logger.info(`Recovered completed Cline session ${interrupted.sessionId}; deferring finalization to the normal completion pipeline.`);
         } else if (restartRecoveryDisposition(interrupted.sessionId, observed) === "resume") {
           this.logger.info(`Persisted queue recovered for ${this.workspace}; observing interrupted Cline session ${interrupted.sessionId} for ${this.scanner.interTaskDelayMs}ms before resuming it.`);
           await abortableDelay(this.scanner.interTaskDelayMs, this.abortController.signal);
           if (this.abortController.signal.aborted || this.data.paused) return;
           const refreshed = await getLegacyWorkspaceSessionStatus(this.workspace);
           if (!interrupted.pendingRecoveryContinuation && restartRecoveryContinuationRequired(interrupted.sessionId, observed, refreshed)) {
             await this.sendToOwnedSession(interrupted.sessionId, "Continue the current task from where it was interrupted by the VS Code reload. Stay in this same task, complete all remaining work, and validate the full original scope before completing.", "restart recovery continuation");
             this.recordHistoryEvent({ type: "queue_restart_interrupted_session_resumed", source: "scanner", observed: true, taskId: interrupted.id, queueItemId: interrupted.id, clineSessionId: interrupted.sessionId, payload: { status: refreshed?.status, observedAt: refreshed?.observedAt } });
             this.logger.info(`Resumed interrupted Cline session ${interrupted.sessionId} after stable restart inactivity.`);
           } else {
             observed = refreshed;
             this.logger.info(interrupted.pendingRecoveryContinuation
               ? `Cline session ${interrupted.sessionId} has a persisted recovery continuation; suppressing the generic restart message.`
               : `Cline session ${interrupted.sessionId} changed during restart recovery; no duplicate continuation was sent.`);
           }
         }
       }
       if (!interrupted) {
         this.logger.info(`Waiting for ${this.scanner.interTaskDelayMs}ms of stable Cline idle before dispatching the next queued task for ${this.workspace}.`);
         await waitForLegacyWorkspaceIdleStability(this.workspace, this.scanner.interTaskDelayMs, this.abortController.signal, this.logger, undefined,
           sessionId => (this.data.ignoredWaitingTaskIds ?? []).includes(sessionId));
         if (this.abortController.signal.aborted || this.data.paused) return;
       }
       if (interrupted?.pendingRecoveryContinuation) {
         const current = await getLegacyWorkspaceSessionStatus(this.workspace);
         if (!recoveryContinuationRequired(interrupted.pendingRecoveryContinuation.sessionId, current)) {
           this.logger.info(`Cline session ${current!.sessionId} already supersedes or completed recovery for queued task ${interrupted.id}; suppressing stale continuation delivery.`);
         } else await this.deliverPendingRecoveryContinuation(interrupted, true);
       }
       this.restartRecoveryPending = false;
       this.logger.info(`Persisted queue restart recovery completed for ${this.workspace}.`);
     }
     while (!this.abortController.signal.aborted) {
      let item = this.data.items.find(candidate => candidate.state === "running");
      if (!item) {
        if (this.data.paused) return;
        item = this.data.items.find(candidate => candidate.state === "queued");
        if (!item) return;
        if (this.scanner.waitForLmStudio) await this.waitForBackend?.(this.abortController.signal);
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
        item.state = queueStateTransition(item.state, "running"); item.dispatchedAt = new Date().toISOString(); item.activeMs = 0; item.activeSince = item.dispatchedAt;
        this.data.ignoredWaitingTaskIds = [];
        await this.persist();
        try {
          if (item.kind === "message") {
            await this.sendToOwnedSession(item.targetSessionId!, item.prompt, "queued message");
            this.logger.info(`Dispatched queued message ${item.id} from ${item.sourcePath}.`);
          } else {
            if (item.resumeSessionId) {
              await this.sendToOwnedSession(item.resumeSessionId, "Complete all unfinished work in this existing task. Validate the full original scope before completing.", "historical-task continuation");
              item.sessionId = item.resumeSessionId;
              this.logger.info(`Resumed historical Cline task ${item.resumeSessionId} for queue item ${item.id}.`);
            } else {
              await this.adapter.newTask(item.prompt);
              this.logger.info(`Dispatched queued task ${item.id} from ${item.sourcePath}.`);
            }
          }
        }
        catch (error) { this.pauseTaskTimer(item); item.state = queueStateTransition(item.state, "failed"); item.finishedAt = new Date().toISOString(); item.error = error instanceof Error ? error.message : String(error); await this.persist(); continue; }
      }
      try {
        const result = item.kind === "message"
          ? await waitForLegacyMessageCompletion(this.workspace, item.targetSessionId!, this.abortController.signal, this.logger)
          : await waitForLegacyTaskCompletion(this.workspace, item.prompt, item.dispatchedAt!, this.abortController.signal, this.logger, undefined, undefined, {
            knownSessionId: item.sessionId,
            currentSessionId: () => item!.sessionId,
            afterCompletionMarker: item.lastCompletionMarker,
            afterRecoveryMarker: item.lastRecoveryMarker,
            afterFailureMarker: item.lastFailureMarker,
            afterTestTimeoutMarker: item.lastTestTimeoutMarker,
            scopePath: item.scopePath,
            afterScopeViolationMarker: item.lastScopeViolationMarker,
            terminalStabilityMs: this.scanner.terminalStabilityMs,
            detectTestTimeouts: this.scanner.enabled && this.scanner.detectTestTimeouts,
            onSessionObserved: async sessionId => {
              if (!sessionReplacementAllowed(item.sessionId, sessionId)) return;
              item.sessionId = sessionId;
              if (!(this.data.ownedSessionIds ?? []).includes(sessionId)) this.data.ownedSessionIds = [...(this.data.ownedSessionIds ?? []).slice(-199), sessionId];
              await this.persist();
            },
            onActivityStatus: async (status, completionClaim) => this.observeTaskActivity(item!, status, completionClaim)
          });
        if (result.sessionId && sessionReplacementAllowed(item.sessionId, result.sessionId)) item.sessionId = result.sessionId;
        if (item.pendingRecoveryContinuation && result.status !== "task_failed" && result.status !== "context_overflow") {
          item.pendingRecoveryContinuation = undefined;
          item.error = undefined;
          await this.persist();
        }
        this.recordHistoryEvent({ type: "cline_task_observation", source: "cline", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: result });
        if (item.kind !== "message" && result.status === "user_confirmed_done") {
          this.pauseTaskTimer(item);
          item.userConfirmedCompletion = true;
          item.state = queueStateTransition(item.state, "completed");
          item.finishedAt = new Date().toISOString();
          item.error = undefined;
          await this.persist();
          this.recordHistoryEvent({ type: "user_confirmed_completion", source: "scanner", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: { sourcePath: item.sourcePath, marker: result.userConfirmedDoneMarker } });
          try { await this.cleanupTerminals?.(); }
          catch (error) { this.logger.error(`Terminal cleanup failed: ${String(error)}`); }
          this.logger.info(`Observed standalone DONE in Cline session ${result.sessionId}; completed queue item ${item.id}.`);
          continue;
        }
        if (item.kind !== "message" && result.status === "scope_violation") {
          item.lastScopeViolationMarker = result.scopeViolationMarker;
          await this.persist();
          await this.sendToOwnedSession(result.sessionId, scopeViolationFollowup(item.scopePath!, result.violatingPaths ?? []), "scope correction");
          this.recordHistoryEvent({ type: "task_scope_violation", source: "scanner", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: { scopePath: item.scopePath, violatingPaths: result.violatingPaths, marker: result.scopeViolationMarker } });
          this.logger.info(`Retained Cline task ${result.sessionId} after detecting edits outside ${item.scopePath}.`);
          continue;
        }
         if (item.kind !== "message" && result.status === "context_overflow") {
           item.lastRecoveryMarker = result.recoveryMarker;
           item.pendingRecoveryContinuation = {
             kind: "context_overflow", marker: result.recoveryMarker!, sessionId: result.sessionId,
             message: "Continue the current task from where you stopped. Complete all remaining work and validate it before completing the task."
           };
           await this.persist();
           await this.sendToOwnedSession(result.sessionId, "/compact", "context compaction");
           this.logger.info(`Requested context compaction for Cline task ${result.sessionId}.`);
           await waitForLegacyMessageCompletion(this.workspace, result.sessionId, this.abortController.signal, this.logger);
           await this.deliverPendingRecoveryContinuation(item, false);
           continue;
         }
         if (item.kind !== "message" && result.status === "task_failed") {
           item.lastFailureMarker = result.failureMarker;
           item.error = result.errorText;
           item.pendingRecoveryContinuation = { kind: "task_failure", marker: result.failureMarker!, sessionId: result.sessionId, message: "continue" };
           await this.persist();
           if (this.scanner.restartOnYoloFailure && isYoloConsecutiveMistakesFailure(result.errorText)) {
             if (await this.requestYoloRestartIfRequired(item)) return;
           }
           await this.sendToOwnedSession(result.sessionId, "/compact", "failure compaction");
           this.logger.info(`Requested context compaction after Cline task failure ${result.failureMarker}.`);
           await waitForLegacyMessageCompletion(this.workspace, result.sessionId, this.abortController.signal, this.logger);
           await this.deliverPendingRecoveryContinuation(item, false);
           continue;
         }
        if (this.scanner.enabled && this.scanner.detectTestTimeouts && item.kind !== "message" && result.status === "test_timeout") {
          item.lastTestTimeoutMarker = result.testTimeoutMarker;
          item.error = result.errorText;
          await this.persist();
          await this.sendToOwnedSession(result.sessionId, testTimeoutFollowup(result.timedOutCommand), "test-timeout correction");
          this.recordHistoryEvent({ type: "unresolved_test_timeout", source: "scanner", taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: { marker: result.testTimeoutMarker, command: result.timedOutCommand, error: result.errorText } });
          this.logger.info(`Completion blocked by unresolved test timeout ${result.testTimeoutMarker}.`);
          continue;
        }
         // Also check for completion audit when status is "waiting" - Cline may have sent
         // a completion_result with unfinished work markers before transitioning to waiting state.
         const completionAudit = this.scanner.enabled && this.scanner.detectIncompleteCompletions && item.kind !== "message" && (result.status === "completed" || result.status === "waiting") ? auditCompletionReport(result.completionText, result.taskProgressText) : undefined;
         if (completionAudit?.requiresContinuation) {
          item.incompleteCompletionClaims = (item.incompleteCompletionClaims ?? (item.lastCompletionMarker ? 1 : 0)) + 1;
          item.stuckLoopRounds = result.implementationActivity === true ? 0 : (item.stuckLoopRounds ?? 0) + 1;
          item.lastCompletionMarker = result.completionMarker;
          const correction = completionCorrectionState(item.incompleteCompletionClaims, item.unchangedCompletionCorrectionRounds, result.implementationActivity === true, this.scanner.maxUnchangedCompletionCorrectionRounds);
          item.unchangedCompletionCorrectionRounds = correction.unchangedRounds;
          const checklistOnly = completionAudit.reason.startsWith("task progress incomplete")
            && !auditCompletionReport(result.completionText).requiresContinuation;
          if (correction.limitReached) {
            this.pauseTaskTimer(item);
            item.state = queueStateTransition(item.state, "failed");
            item.finishedAt = new Date().toISOString();
            item.error = `Completion correction limit reached after ${this.scanner.maxUnchangedCompletionCorrectionRounds} consecutive STOP rounds without implementation activity.`;
            await this.persist();
            this.recordHistoryEvent({ type: "completion_correction_limit_reached", source: "scanner", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: { claimCount: item.incompleteCompletionClaims, unchangedRounds: item.unchangedCompletionCorrectionRounds, limit: this.scanner.maxUnchangedCompletionCorrectionRounds, reason: completionAudit.reason, completionMarker: result.completionMarker } });
            this.logger.error(item.error);
            continue;
          }
          // A stuck-loop warning changes strategy but is not a terminal state.
          // Only the explicit unchanged-completion limit above may fail the
          // task, so later implementation and unfinished reports remain under
          // scanner supervision.
          if (!checklistOnly && this.scanner.enabled && this.scanner.detectStuckLoops && item.stuckLoopRounds === this.scanner.maxStuckLoopRounds) {
            await this.persist();
            this.recordHistoryEvent({ type: "llm_stuck_loop_detected", source: "scanner", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: { rounds: item.stuckLoopRounds, completionMarker: result.completionMarker } });
            this.logger.info(`LLM stuck-loop strategy correction requested after ${item.stuckLoopRounds} unchanged completion claims.`);
            await this.sendToOwnedSession(result.sessionId, stuckLoopFollowup(item.stuckLoopRounds), "stuck-loop correction");
            continue;
          }
          await this.persist();
          const remainingSteps = extractRemainingSteps(result.completionText, result.taskProgressText);
          const followup = checklistOnly ? checklistReconciliationFollowup(remainingSteps) : incompleteCompletionFollowup(item.incompleteCompletionClaims, remainingSteps);
          await this.sendToOwnedSession(result.sessionId, followup, "incomplete-completion correction");
          if (item.incompleteCompletionClaims > 1) {
            this.recordHistoryEvent({ type: "repeated_incomplete_completion_claim", source: "scanner", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: { claimCount: item.incompleteCompletionClaims, reason: completionAudit.reason, completionMarker: result.completionMarker, remainingSteps } });
          }
          this.logger.info(`Mandatory completion audit retained Cline task ${result.sessionId}: ${completionAudit.reason}.`);
          continue;
        }
        // Reset stuck loop counter when implementation activity is detected
        if (this.scanner.enabled && item.kind !== "message" && result.implementationActivity === true) {
          item.stuckLoopRounds = 0;
        }
         // Also check audit recommendations when status is "waiting" - Cline may have sent
         // a completion_result before transitioning to waiting state.
         if (this.scanner.enabled && this.scanner.implementAuditRecommendations && item.kind !== "message" && (result.status === "completed" || result.status === "waiting")) {
           const recommendations = extractAuditRecommendations(item.prompt, result.completionText);
          const handled = new Set(item.handledAuditRecommendationKeys ?? []);
          const unhandled = selectUnhandledAuditRecommendations(recommendations, [...handled]);
          if (unhandled.length) {
            item.lastCompletionMarker = result.completionMarker;
            item.handledAuditRecommendationKeys = [...handled, ...unhandled.map(recommendationKey)].slice(-100);
            await this.persist();
            await this.sendToOwnedSession(result.sessionId, auditRecommendationFollowup(unhandled, this.scanner.requirePostImplementationReport), "audit-recommendation continuation");
            this.recordHistoryEvent({ type: "audit_recommendations_requested", source: "scanner", taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: { completionMarker: result.completionMarker, recommendations: unhandled, requirePostImplementationReport: this.scanner.requirePostImplementationReport } });
            this.logger.info(`Retained audit task ${result.sessionId} to implement ${unhandled.length} recommendation(s).`);
            continue;
          }
        }
          // Also check completion verification when status is "waiting" - Cline may have sent
          // a completion_result before transitioning to waiting state.
          if (this.scanner.enabled && this.scanner.verifyCompletionCriteria && item.kind !== "message" && (result.status === "completed" || result.status === "waiting")) {
            const completionConfidence = extractCompletionConfidence(result.completionText);
            const verification = completionVerificationDecision(item.completionVerificationRequested === true, result.implementationActivity === true, completionConfidence, this.scanner.completionConfidenceThreshold, item.completionVerificationRounds ?? 0, this.scanner.maxCompletionVerificationRounds);
           if (verification !== "accept") {
             await this.sendToOwnedSession(result.sessionId, completionVerificationFollowup(verification === "request_after_implementation", this.scanner.completionConfidenceThreshold), "completion verification");
             item.completionVerificationRequested = true;
             item.completionVerificationRounds = (item.completionVerificationRounds ?? 0) + 1;
             item.lastCompletionMarker = result.completionMarker;
             await this.persist();
             this.recordHistoryEvent({
               type: verification === "request_initial" ? "completion_verification_requested" : "completion_reverification_requested",
               source: "scanner", taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId,
               payload: { completionMarker: result.completionMarker, implementationActivity: result.implementationActivity === true, completionConfidence, confidenceThreshold: this.scanner.completionConfidenceThreshold, verificationRound: item.completionVerificationRounds, maxVerificationRounds: this.scanner.maxCompletionVerificationRounds }
             });
             this.logger.info(`${verification === "request_initial" ? "Requested" : "Repeated"} completion verification for Cline task ${result.sessionId}.`);
             continue;
           }
           const acceptedByConfidence = completionConfidence !== undefined
             && completionConfidence >= this.scanner.completionConfidenceThreshold;
           const acceptedByRoundLimit = !acceptedByConfidence
             && result.implementationActivity === true
             && (item.completionVerificationRounds ?? 0) >= this.scanner.maxCompletionVerificationRounds;
           this.recordHistoryEvent({
             type: "completion_verified", source: "scanner", observed: true,
             taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId,
             payload: {
               completionMarker: result.completionMarker,
               implementationActivity: result.implementationActivity === true,
               completionConfidence,
               confidenceThreshold: this.scanner.completionConfidenceThreshold,
               verificationRounds: item.completionVerificationRounds ?? 0,
               maxVerificationRounds: this.scanner.maxCompletionVerificationRounds,
               acceptance: acceptedByConfidence ? "confidence_threshold" : acceptedByRoundLimit ? "bounded_round_limit" : "read_only"
             }
           });
           this.logger.info(acceptedByConfidence
             ? `Accepted completion verification for Cline task ${result.sessionId} at ${completionConfidence}% confidence (threshold ${this.scanner.completionConfidenceThreshold}%).`
             : acceptedByRoundLimit
               ? `Accepted completion verification for Cline task ${result.sessionId} after the bounded ${this.scanner.maxCompletionVerificationRounds}-round limit; no explicit incomplete work was detected.`
             : `Accepted read-only completion verification for Cline task ${result.sessionId}.`);
         }

         // Child task spawning: when a new task is spawned via newTask,
         // the parent queue item's session is replaced and its completion
         // results in immediate completion of the parent process.
         if (result.status === "completed" && result.sessionId !== item.sessionId) {
           this.logger.info(`Child task ${result.sessionId} spawned from parent task ${item.id}; marking parent as completed.`);
           item.sessionId = result.sessionId;
           this.pauseTaskTimer(item);
           item.finishedAt = new Date().toISOString();
           item.state = queueStateTransition(item.state, "completed");
           this.rememberDispatchExemption(result.sessionId);
           await this.persist();
           try { await this.cleanupTerminals?.(); }
           catch (error) { this.logger.error(`Terminal cleanup failed: ${String(error)}`); }
           continue; // Continue to next queued task
         }

          // Also check for reflection when status is "waiting" - Cline may have sent
          // a completion_result before transitioning to waiting state.
          const reflective = item.reflective ?? this.scanner.reflective === true;
          if (this.scanner.enabled && reflective && item.kind !== "message" && (result.status === "completed" || result.status === "waiting") && !item.reflectionRequested) {
            await this.sendToOwnedSession(result.sessionId, reflectiveCompletionFollowup(item.id), "reflective report request");
           item.reflectionRequested = true;
           item.lastCompletionMarker = result.completionMarker;
           await this.persist();
           this.recordHistoryEvent({ type: "reflection_requested", source: "scanner", taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: { completionMarker: result.completionMarker } });
           this.logger.info(`Retained task ${result.sessionId} for reflective completion reporting.`);
           continue;
         }
          // Also record reflection completed when status is "waiting" - Cline may have sent
          // a completion_result before transitioning to waiting state.
          if (this.scanner.enabled && reflective && item.kind !== "message" && (result.status === "completed" || result.status === "waiting") && item.reflectionRequested) {
            this.recordHistoryEvent({ type: "reflection_completed", source: "scanner", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: result.sessionId, payload: { completionText: result.completionText, taskProgressText: result.taskProgressText } });
          }
        if (result.status === "deleted") {
          this.data.paused = true;
          this.pauseTaskTimer(item);
          item.error = "Cline task was interrupted or removed; queue paused without advancing.";
          await this.persist();
          this.recordHistoryEvent({ type: "queue_task_interrupted", source: "scanner", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: item.sessionId, payload: { queuePaused: true } });
          this.logger.info(`Queued task ${item.id} disappeared; queue paused on the interrupted item instead of advancing.`);
          return;
        }
        this.pauseTaskTimer(item);
        item.finishedAt = new Date().toISOString();
        item.state = queueStateTransition(item.state, result.status === "completed" && (result.exitCode === undefined || result.exitCode === 0) ? "completed" : "failed");
        if (item.state === "completed") this.rememberDispatchExemption(result.sessionId);
        if (item.state === "failed") item.error = result.errorText ?? `Cline session ended with ${result.status}${result.exitCode === undefined ? "" : ` (exit ${result.exitCode})`}.`;

        if (item.kind !== "message" && item.state === "completed") {
          try { await this.cleanupTerminals?.(); }
          catch (error) { this.logger.error(`Terminal cleanup failed: ${String(error)}`); }
        }
        // Enforce git commit after task completion
        if (item.state === "completed" && !item.kind?.includes("message")) {
          try {
            const gitResult = enforceGitCommit(this.workspace, item.prompt);
            if (!gitResult.committed) {
              this.logger.info(`Git commit not required for ${item.id}: ${gitResult.error || gitResult.message}`);
            } else {
              this.logger.info(`Git committed after task ${item.id}: ${gitResult.message}`);
            }
          } catch (error) {
            this.logger.debug(`Failed to enforce git commit for ${item.id}: ${(error as Error).message}`);
          }
        }

        await this.persist();
        await this.resetFinishedQueueLifecycle();
       } catch (error) {
         // Queue control aborts only the monitor. Preserve the running item and
         // its session identity so pause, shutdown, DONE, and workspace restart
         // cannot turn an interruption into a fresh dispatch or advance to the
         // next item.
         if (this.abortController.signal.aborted) return;
         this.pauseTaskTimer(item); item.state = queueStateTransition(item.state, "failed"); item.finishedAt = new Date().toISOString(); item.error = error instanceof Error ? error.message : String(error); await this.persist(); await this.resetFinishedQueueLifecycle();
       }
     }
   }

  private async observeTaskActivity(item: QueueItem, status: "running" | "waiting" | "completed", completionClaim: boolean): Promise<void> {
    if (item.state !== "running") return;
    checkpointTaskTimer(item, status, completionClaim);
    await this.persist();
  }

  private pauseTaskTimer(item: QueueItem, now = Date.now()): void {
    const since = item.activeSince ? Date.parse(item.activeSince) : Number.NaN;
    if (Number.isFinite(since) && now >= since) item.activeMs = (item.activeMs ?? 0) + (now - since);
    item.activeSince = undefined;
  }

  private queueLifecycleFinished(): boolean {
    return this.data.items.length > 0
      && !this.data.items.some(item => item.state === "queued" || item.state === "running");
  }

  private resetLifecycleCounters(now = new Date().toISOString()): void {
    this.data.timingVersion = 4;
    this.data.timingResetAt = now;
    this.data.tokenUsageBySession = {};
    this.data.ignoredWaitingTaskIds = [];
    this.data.compactedNewTaskMarkers = [];
    this.data.handledNewTaskMarkers = [];
    this.lastTokenUsagePersistAt = 0;
  }

  private async resetFinishedQueueLifecycle(): Promise<void> {
    if (!this.queueLifecycleFinished()) return;
    this.resetLifecycleCounters();
    await this.persist();
    this.logger.info(`Queue lifecycle completed for ${this.workspace}; live counters and retained terminal items were reset.`);
  }

  private async load(): Promise<void> {
    try {
      const value = JSON.parse(await fs.readFile(this.file, "utf8")) as QueueFile;
      if (value.version === 1 && value.workspace === this.workspace && Array.isArray(value.items)) this.data = value;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.logger.error(`Failed to load queue: ${String(error)}`); }
  }

  private async migrateRecoveryProtocol(): Promise<void> {
    if (this.data.recoveryProtocolVersion === 1) return;
    const interrupted = this.data.items.find(item => item.kind !== "message" && item.state === "running" && item.sessionId);
    if (interrupted && !interrupted.pendingRecoveryContinuation) {
      if (interrupted.lastFailureMarker && interrupted.error) {
        interrupted.pendingRecoveryContinuation = { kind: "task_failure", marker: interrupted.lastFailureMarker, sessionId: interrupted.sessionId!, message: "continue" };
      } else if (interrupted.lastRecoveryMarker) {
        interrupted.pendingRecoveryContinuation = {
          kind: "context_overflow", marker: interrupted.lastRecoveryMarker, sessionId: interrupted.sessionId!,
          message: "Continue the current task from where you stopped. Complete all remaining work and validate it before completing the task."
        };
      }
    }
    this.data.recoveryProtocolVersion = 1;
    await this.persist();
  }

  private async deliverPendingRecoveryContinuation(item: QueueItem, afterRestart: boolean): Promise<void> {
    const pending = item.pendingRecoveryContinuation;
    if (!pending) return;
    const repeatedYoloFailure = pending.kind === "task_failure"
      && item.lastYoloRestartMarker === pending.marker
      && isYoloConsecutiveMistakesFailure(item.error);
    if (afterRestart && repeatedYoloFailure) {
      await this.restartYoloTaskFresh(item, pending.marker);
      return;
    }
    const message = repeatedYoloFailure ? yoloFailureDiagnosticFollowup() : pending.message;
    await this.sendToOwnedSession(pending.sessionId, message, repeatedYoloFailure ? "post-restart YOLO diagnostic continuation" : afterRestart ? "restart recovery continuation" : "recovery continuation");
    item.pendingRecoveryContinuation = undefined;
    item.error = undefined;
    await this.persist();
    this.recordHistoryEvent({ type: repeatedYoloFailure ? "yolo_diagnostic_continuation_delivered" : "recovery_continuation_delivered", source: "cline-console", taskId: item.id, queueItemId: item.id, clineSessionId: pending.sessionId, payload: { kind: pending.kind, marker: pending.marker, afterRestart } });
    this.logger.info(`Requested continuation after ${pending.kind === "task_failure" ? "Cline task failure" : "context compaction"} ${pending.marker}${afterRestart ? " during restart recovery" : ""}.`);
  }

  private async restartYoloTaskFresh(item: QueueItem, marker: string): Promise<void> {
    const previousSessionId = item.sessionId;
    const started = await this.adapter.newTask(item.prompt);
    let sessionId = started.taskId;
    const deadline = Date.now() + POLICY_MESSAGE_TIMEOUT_MS;
    while (!sessionId && Date.now() < deadline && !this.abortController.signal.aborted) {
      const latest = await getLatestLegacyWorkspaceTaskPrompt(this.workspace);
      if (latest?.sessionId !== previousSessionId && latest?.prompt === item.prompt) sessionId = latest.sessionId;
      if (!sessionId) await abortableDelay(250, this.abortController.signal);
    }
    if (!sessionId) throw new Error(`Fresh YOLO recovery task did not expose a session ID within ${POLICY_MESSAGE_TIMEOUT_MS}ms.`);

    item.sessionId = sessionId;
    if (!(this.data.ownedSessionIds ?? []).includes(sessionId)) this.data.ownedSessionIds = [...(this.data.ownedSessionIds ?? []).slice(-199), sessionId];
    // Persist ownership before messaging so a crash cannot turn the fresh
    // session into unmanaged work. Keep the recovery marker pending until the
    // diagnostic follow-up is durably delivered; startup will retry otherwise.
    await this.persist();
    await this.sendToOwnedSession(sessionId, yoloFailureDiagnosticFollowup(), "fresh post-restart YOLO diagnostic continuation");

    item.pendingRecoveryContinuation = undefined;
    item.error = undefined;
    item.lastYoloFreshRecoveryMarker = marker;
    item.lastCompletionMarker = undefined;
    item.completionVerificationRequested = undefined;
    item.completionVerificationRounds = 0;
    item.reflectionRequested = undefined;
    item.incompleteCompletionClaims = 0;
    item.unchangedCompletionCorrectionRounds = 0;
    item.stuckLoopRounds = 0;
    await this.persist();
    this.recordHistoryEvent({ type: "yolo_fresh_session_recovery", source: "cline-console", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: sessionId, payload: { marker, previousSessionId } });
    this.logger.info(`Restarted YOLO-failed queue item ${item.id} in fresh Cline session ${sessionId}; previous session ${previousSessionId ?? "unknown"} was not reopened.`);
  }

  private async requestYoloRestartIfRequired(item: QueueItem): Promise<boolean> {
    const pending = item.pendingRecoveryContinuation;
    if (!this.scanner.restartOnYoloFailure || pending?.kind !== "task_failure" || !shouldRequestYoloRestart(item.error, pending.marker, item.lastYoloRestartMarker)) return false;
    item.lastYoloRestartMarker = pending.marker;
    item.lastYoloRestartAt = new Date().toISOString();
    item.yoloRestartCount = (item.yoloRestartCount ?? 0) + 1;
    await this.persist();
    try { await this.cleanupTerminals?.(); }
    catch (error) { this.logger.error(`Pre-restart workspace cleanup failed: ${String(error)}`); }
    await writeYoloRestartRequest(runtimeDirectory(), {
      workspace: this.workspace, queueItemId: item.id, sessionId: pending.sessionId,
      failureMarker: pending.marker, errorText: item.error ?? "YOLO MODE consecutive-mistakes failure"
    });
    this.recordHistoryEvent({ type: "yolo_workspace_restart_requested", source: "scanner", observed: true, taskId: item.id, queueItemId: item.id, clineSessionId: pending.sessionId, payload: { marker: pending.marker, error: item.error } });
    this.logger.info(`Requested daemon-managed workspace restart after YOLO failure ${pending.marker}.`);
    return true;
  }

  private async sendToOwnedSession(sessionId: string, message: string, purpose: string, selectSession = true): Promise<void> {
    const delivery = this.deliveryChain.then(() => deliverTaskBoundMessage(this.adapter, sessionId, message, purpose, this.abortController.signal, this.ownsSession(sessionId), selectSession));
    this.deliveryChain = delivery.catch(() => undefined);
    await delivery;
  }

  private async persist(recordSnapshot = true): Promise<void> {
    if (this.ownsWriterLease && !await this.ownsWriterLease()) {
      this.abortController.abort();
      if (!this.writerLeaseLossLogged) {
        this.writerLeaseLossLogged = true;
        this.logger.error(`Stopped stale queue worker for ${this.workspace}: this extension host no longer owns the workspace registration.`);
      }
      throw new ClineConsoleError("QUEUE_WRITER_LEASE_LOST", "This extension host no longer owns the workspace queue writer lease.");
    }
    const serialized = JSON.stringify(this.data, null, 2);
    const operation = this.persistenceChain.catch(() => undefined).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, serialized, { mode: 0o600 });
        await fs.rename(temporary, this.file);
      } finally {
        await fs.unlink(temporary).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
      if (recordSnapshot) this.recordHistory("queue_persisted");
    });
    this.persistenceChain = operation;
    await operation;
  }

  private recordHistory(reason: string): void {
    if (!this.history) return;
    const promptBytes = this.data.items.reduce((total, item) => total + Buffer.byteLength(item.prompt, "utf8"), 0);
    if (promptBytes > MAX_HISTORY_SNAPSHOT_PROMPT_BYTES) {
      if (!this.largeSnapshotSuppressionLogged) {
        this.logger.info(`Suppressed full SQLite queue snapshot for ${this.workspace}: ${promptBytes} prompt bytes exceed the ${MAX_HISTORY_SNAPSHOT_PROMPT_BYTES}-byte history limit; persistent queue JSON and incremental history remain authoritative.`);
        this.largeSnapshotSuppressionLogged = true;
      }
      return;
    }
    try { this.history.recordQueueSnapshot(this.workspace, this.data.items, reason, { paused: this.data.paused === true, ignoredWaitingTaskIds: this.data.ignoredWaitingTaskIds ?? [], compactedNewTaskMarkers: this.data.compactedNewTaskMarkers ?? [], handledNewTaskMarkers: this.data.handledNewTaskMarkers ?? [] }); }
    catch (error) { this.logger.error(`Failed to record SQLite history snapshot: ${String(error)}`); }
  }

  private recordHistoryEvent(event: Parameters<HistoryStore["recordEvent"]>[1]): void {
    if (!this.history) return;
    try { this.history.recordEvent(this.workspace, event); }
    catch (error) { this.logger.error(`Failed to record SQLite history event: ${String(error)}`); }
  }

   async stop(): Promise<void> { this.abortController.abort(); await Promise.all([this.worker, this.policyWorker]); }

  /**
   * Get supervision report for current queue items
   */
  getSupervisionReport(options?: TaskSupervisionOptions): string {
    return generateSupervisionReport(this.data.items, options);
  }

  /**
   * Check supervision status and log warnings if enabled
   */
  checkSupervision(): void {
    const result = checkTaskSupervision(this.data.items);

    // Log warnings for tasks approaching limits (using info level since Logger has no warn method)
    for (const item of result.warningTasks) {
      this.logger.info(`Task ${item.id} approaching duration limit: ${(Date.now() - (item.dispatchedAt ? Date.parse(item.dispatchedAt) : item.queuedAt ? Date.parse(item.queuedAt) : Date.now())) / 1000}s`);
    }

    // Log timeout issues
    if (result.timedOutTasks.length > 0) {
      this.logger.error(`Found ${result.timedOutTasks.length} timed-out task(s): ${result.summary}`);
    }
  }
}

export async function readQueueStatusFile(file: string, workspace: string): Promise<QueueStatus> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as QueueFile;
    if (value.version === 1 && value.workspace === workspace && Array.isArray(value.items)) return buildQueueStatus(workspace, value.items, value.paused === true, value.timingResetAt);
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
        statuses.push(buildQueueStatus(value.workspace, value.items, value.paused === true, value.timingResetAt));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return statuses.sort((left, right) => left.workspace.localeCompare(right.workspace));
}

export function reconcileQueueStatus(status: QueueStatus, companionConnected: boolean, activity?: { status?: string }): QueueStatus {
  const observedState: QueueStatus["items"][number]["state"] = !companionConnected ? "interrupted"
    : activity?.status === "running" ? "running"
    : activity?.status === "waiting" || activity?.status === "completed" || activity?.status === "idle" ? "waiting"
    : activity?.status === "failed" ? "failed"
    : "interrupted";
  const items = status.items.map(item => item.state === "running" ? { ...item, state: observedState } : item);
  return {
    ...status,
    items,
    running: items.filter(item => item.state === "running").length,
    interrupted: items.filter(item => item.state === "interrupted").length
  };
}

export function taskTimerShouldRun(status: "running" | "waiting" | "completed", completionClaim: boolean): boolean {
  // Only confirmed execution is billable. Waiting includes stopped tasks,
  // resume prompts, and scanner gaps; a later running observation starts a new
  // active interval without charging the idle wall-clock gap.
  void completionClaim;
  return status === "running";
}

export function checkpointTaskTimer(item: { activeMs?: number; activeSince?: string }, status: "running" | "waiting" | "completed", completionClaim: boolean, now = Date.now()): void {
  const since = item.activeSince ? Date.parse(item.activeSince) : Number.NaN;
  if (Number.isFinite(since) && now >= since) item.activeMs = (item.activeMs ?? 0) + (now - since);
  item.activeSince = taskTimerShouldRun(status, completionClaim) ? new Date(now).toISOString() : undefined;
}

export function restartRecoveryDisposition(sessionId: string | undefined, observed?: { sessionId: string; status: string }): "complete" | "resume" | "preserve" {
  if (!sessionId || observed?.sessionId !== sessionId) return "preserve";
  if (observed.status === "completed") return "complete";
  return observed.status === "running" || observed.status === "waiting" || observed.status === "stale" ? "resume" : "preserve";
}

export function restartRecoveryContinuationRequired(sessionId: string, before?: { sessionId: string; status: string; observedAt?: string }, after?: { sessionId: string; status: string; observedAt?: string }): boolean {
  return before?.sessionId === sessionId
    && after?.sessionId === sessionId
    && restartRecoveryDisposition(sessionId, after) === "resume"
    && before.status === after.status
    && before.observedAt === after.observedAt;
}

export function rememberIgnoredSession(existing: string[] | undefined, sessionId: string): string[] {
  return [...new Set([...(existing ?? []), sessionId])].slice(-20);
}

export function buildQueueStatus(workspace: string, items: QueueItem[], paused = false, timingResetAt?: string): QueueStatus {
  const active = items.filter(item => item.state === "running" || item.state === "queued");
  const belongsToCurrentLifecycle = (item: QueueItem): boolean => !timingResetAt || !item.finishedAt
    || Date.parse(item.finishedAt) > Date.parse(timingResetAt);
  const currentLifecycleItems = items.filter(belongsToCurrentLifecycle);
  const closed = currentLifecycleItems.filter(item => item.state === "completed" && item.userConfirmedCompletion).slice(-1);
  const durationSamples = items.flatMap(item => {
    if (item.state !== "completed") return [];
    if (timingResetAt && (!item.dispatchedAt || !item.finishedAt
      || Date.parse(item.dispatchedAt) < Date.parse(timingResetAt)
      || Date.parse(item.finishedAt) < Date.parse(timingResetAt))) return [];
    const durationMs = item.activeMs ?? (item.dispatchedAt && item.finishedAt ? Date.parse(item.finishedAt) - Date.parse(item.dispatchedAt) : Number.NaN);
    return Number.isFinite(durationMs) && durationMs >= 0 ? [durationMs] : [];
  });
  const timing = calculateTaskTiming(durationSamples);
  return {
    workspace,
    paused,
    queueLength: active.length,
    running: active.filter(item => item.state === "running").length,
    queued: active.filter(item => item.state === "queued").length,
    completed: currentLifecycleItems.filter(item => item.state === "completed").length,
    failed: currentLifecycleItems.filter(item => item.state === "failed").length,
    skipped: currentLifecycleItems.filter(item => item.state === "skipped").length,
    timing,
    items: [...active.map((item, index) => ({
      position: index + 1,
      id: item.id,
      kind: item.kind ?? "task",
      state: item.state === "running" && /interrupted/i.test(item.error ?? "") ? "interrupted" as const : item.state as "queued" | "running",
      title: taskTitle(item.prompt) ?? "(untitled)",
      sourcePath: item.sourcePath,
      ...(item.scopePath ? { scopePath: item.scopePath } : {}),
      queuedAt: item.queuedAt,
      ...(item.dispatchedAt ? { dispatchedAt: item.dispatchedAt } : {}),
      ...(item.activeMs !== undefined ? { activeMs: item.activeMs } : {}),
      ...(item.activeSince ? { activeSince: item.activeSince } : {}),
      ...(item.sessionId ? { sessionId: item.sessionId } : {}),
      ...(item.lastYoloRestartMarker ? {
        lastYoloRestartAt: item.lastYoloRestartAt ?? markerTimestamp(item.lastYoloRestartMarker),
        yoloRestartCount: item.yoloRestartCount ?? 1
      } : {})
    })), ...closed.map(item => ({
      id: item.id,
      kind: item.kind ?? "task",
      state: "closed" as const,
      title: taskTitle(item.prompt) ?? "(untitled)",
      sourcePath: item.sourcePath,
      ...(item.scopePath ? { scopePath: item.scopePath } : {}),
      queuedAt: item.queuedAt,
      ...(item.dispatchedAt ? { dispatchedAt: item.dispatchedAt } : {}),
      ...(item.activeMs !== undefined ? { activeMs: item.activeMs } : {}),
      ...(item.activeSince ? { activeSince: item.activeSince } : {}),
      ...(item.sessionId ? { sessionId: item.sessionId } : {})
    }))]
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position), upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Build a robust workspace-duration model while retaining the legacy estimate field. */
export function calculateTaskTiming(samples: number[]): NonNullable<QueueStatus["timing"]> {
  const values = samples.filter(value => Number.isFinite(value) && value >= 0);
  if (!values.length) return { sampleCount: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const averageMs = values.reduce((sum, value) => sum + value, 0) / values.length;
  const p25Ms = percentile(sorted, 0.25);
  const medianMs = percentile(sorted, 0.5);
  const p75Ms = percentile(sorted, 0.75);
  const p90Ms = percentile(sorted, 0.9);
  const trim = values.length >= 5 ? Math.max(1, Math.floor(values.length * 0.1)) : 0;
  const trimmed = trim ? sorted.slice(trim, -trim) : sorted;
  const trimmedMeanMs = trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
  const iqr = p75Ms - p25Ms;
  const lowerFence = Math.max(0, p25Ms - iqr * 1.5), upperFence = p75Ms + iqr * 1.5;
  const winsorized = values.map(value => Math.min(upperFence, Math.max(lowerFence, value)));
  const ewmaMs = winsorized.slice(1).reduce((estimate, value) => estimate * 0.65 + value * 0.35, winsorized[0]);
  const spreadRatio = medianMs > 0 ? (p75Ms - p25Ms) / medianMs : p75Ms > p25Ms ? 1 : 0;
  const variance = values.reduce((sum, value) => sum + (value - averageMs) ** 2, 0) / values.length;
  const standardDeviationMs = Math.sqrt(variance);
  const coefficientVariation = averageMs > 0 ? standardDeviationMs / averageMs : 0;
  const totalMs = values.reduce((sum, value) => sum + value, 0);
  const tasksPerHour = totalMs > 0 ? values.length * 3_600_000 / totalMs : undefined;
  const recentValues = values.slice(-Math.min(5, values.length)).sort((left, right) => left - right);
  const recentMedianMs = percentile(recentValues, 0.5);
  let trend: "faster" | "stable" | "slower" | undefined;
  if (values.length >= 4) {
    const split = Math.floor(values.length / 2);
    const older = [...values.slice(0, split)].sort((left, right) => left - right);
    const newer = [...values.slice(split)].sort((left, right) => left - right);
    const olderMedian = percentile(older, 0.5), newerMedian = percentile(newer, 0.5);
    const ratio = olderMedian > 0 ? newerMedian / olderMedian : newerMedian > 0 ? 2 : 1;
    trend = ratio < 0.85 ? "faster" : ratio > 1.15 ? "slower" : "stable";
  }
  const blended = medianMs * 0.45 + ewmaMs * 0.35 + trimmedMeanMs * 0.2;
  // Keep the default prediction robust and non-optimistic without allowing one
  // extreme sample to pull it beyond the historical P90 boundary.
  const estimateMs = Math.min(p90Ms, Math.max(medianMs, blended));
  const confidence = values.length < 3 ? "low"
    : values.length >= 8 && spreadRatio <= 0.75 ? "high"
    : "medium";
  return {
    sampleCount: values.length,
    averageMs,
    estimateMs,
    lastMs: values.at(-1),
    medianMs,
    p25Ms,
    p75Ms,
    p90Ms,
    trimmedMeanMs,
    ewmaMs,
    minMs: sorted[0],
    maxMs: sorted.at(-1),
    standardDeviationMs,
    coefficientVariation,
    ...(tasksPerHour !== undefined ? { tasksPerHour } : {}),
    recentMedianMs,
    ...(trend ? { trend } : {}),
    spreadRatio,
    confidence
  };
}

function firstLine(value: string): string {
  return taskTitle(value) ?? "(untitled)";
}

function markerTimestamp(marker: string): string | undefined {
  const timestamp = Number(marker.slice(marker.lastIndexOf(":") + 1));
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : undefined;
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

export function checklistReconciliationFollowup(remainingSteps: string[]): string {
  return `Your completion report and task_progress disagree. Stay in this same task and reconcile only these unchecked items:\n${remainingSteps.map(step => `- ${step}`).join("\n")}\nUse the implementation and validation evidence already collected. If an item is already satisfied, update task_progress to [x] and cite that evidence. Otherwise finish that specific item and validate it. Do not rebuild the requirements matrix, repeat successful unchanged builds, or make cosmetic edits. Publish the corrected task_progress before completing. Never check an item without evidence.`;
}

export function incompleteCompletionFollowup(claimCount: number, remainingSteps: string[] = []): string {
  const exactItems = remainingSteps.length
    ? `\n\nThe scanner detected these concrete remaining steps:\n${remainingSteps.map((item, index) => `${index + 1}. ${JSON.stringify(item)}`).join("\n")}\n\nResolve each named item directly. If an incomplete item claims it is COMPLETED, resolve the contradiction by verifying the implementation and evidence, then accurately mark it complete or remove the unsupported claim.`
    : "";
  if (claimCount <= 1) return `Complete all unfinished work.${exactItems}\n\nReview the original task and your completion report, implement every remaining, pending, deferred, future, incomplete, or unvalidated item, and do not complete again until the entire requested scope is finished and validated.`;
  return `STOP: you have repeatedly claimed completion while the completion audit still finds incomplete steps. Stay in this same task and do not provide another completion summary yet.${exactItems}\n\nRe-read the complete original task prompt. Rebuild task_progress from the full original scope rather than the shortened checklist: create a stage-by-stage requirements matrix covering every original implementation, architecture, integration, security, persistence, concurrency, serialization, observability, validation, audit/remediation, documentation, and completion criterion. For every requirement, record PASS with concrete file or command evidence, or implement and validate the missing work. Do not call attempt_completion while any checkbox is unchecked, any requirement lacks evidence, or any requested validation remains unrun without an explicit justified blocker.`;
}

export function stuckLoopFollowup(rounds: number): string {
  return `LLM STUCK LOOP DETECTED: You have made ${rounds} consecutive completion claims without implementation activity. This indicates you are stuck in a loop.

STOP: Do not make another completion claim yet. Instead:

1. Analyze what pattern you are repeating that is not producing progress
2. Identify the root cause of why your current approach isn't working
3. Propose a concrete new approach or ask for clarification about what you should do differently

Make one specific request for guidance or propose one new strategy to break out of this loop. Do not continue with the same pattern that has failed multiple times.`;
}

export function completionCorrectionState(claimCount: number, previousUnchangedRounds: number | undefined, implementationActivity: boolean, limit: number): { unchangedRounds: number; limitReached: boolean } {
  if (claimCount <= 2) return { unchangedRounds: previousUnchangedRounds ?? 0, limitReached: false };
  const unchangedRounds = implementationActivity ? 0 : (previousUnchangedRounds ?? 0) + 1;
  return { unchangedRounds, limitReached: unchangedRounds >= Math.max(1, limit) };
}

export function testTimeoutFollowup(command?: string): string {
  const exactCommand = command ? `\n\nTimed-out test command:\n${JSON.stringify(command)}` : "";
  return `Do not complete the task: a test command timed out and the timeout is unresolved.${exactCommand}\n\nDiagnose whether the hang is in the production code, test fixture, teardown, background worker, async task, subprocess, or test runner. Improve the tests so every potentially blocking operation has a justified bounded timeout and cleanup path, and add or strengthen a regression test that reproduces the hang without leaving processes or threads behind. Then rerun the timed-out test scope (not merely a narrower substitute) and provide explicit passing output. If the original scope is inherently long-running, use an explicit justified outer timeout and progress evidence; do not reinterpret a timeout as a pass.`;
}

export function isYoloConsecutiveMistakesFailure(errorText?: string): boolean {
  const text = errorText ?? "";

  // Check for YOLO MODE with various failure indicators
  if (!/YOLO MODE/i.test(text)) return false;

  // Match consecutive mistakes patterns (3 mistakes)
  if (
    /(?:too many\s+)?consecutive mistakes?\s*\(?3\)?/i.test(text)
    || /\b3\s+consecutive mistakes?\b/i.test(text)
  ) {
    return true;
  }

  // Also match other YOLO-specific failure patterns
  if (
    /YOLO MODE.*(?:task failed|stopp?ed|aborted|disabled)/i.test(text)
    || /(?:too many|maximum|limit).*consecutive mistakes/i.test(text)
    || /consecutive mistakes.*(too many|maximum|limit)/i.test(text)
    || /consecutive mistakes/i.test(text) && /fail/i.test(text)
  ) {
    return true;
  }

  // Match any YOLO MODE followed by failure-related keywords
  if (/YOLO MODE[\s\S]{0,200}(?:failed|stop|abort|disabled)/i.test(text)) {
    return true;
  }

  return false;
}

export function yoloFailureDiagnosticFollowup(): string {
  return "The previous attempt hit YOLO MODE's three-consecutive-mistakes safeguard. Stay in this same task. First diagnose why the same tool, search, or execution mistake repeated; revise the approach and perform smaller, independently validated intermediate steps. Then continue the original task through its remaining scope and validate it before claiming completion.";
}

export function shouldRequestYoloRestart(errorText: string | undefined, failureMarker: string, lastRestartMarker?: string): boolean {
  return isYoloConsecutiveMistakesFailure(errorText) && failureMarker !== lastRestartMarker;
}

export function yoloFreshRecoveryRequired(lastRestartMarker?: string, lastFreshRecoveryMarker?: string): boolean {
  return typeof lastRestartMarker === "string" && lastRestartMarker.length > 0 && lastRestartMarker !== lastFreshRecoveryMarker;
}

export function recoveryContinuationRequired(pendingSessionId: string, current?: { sessionId: string; status: string }): boolean {
  if (!current) return true;
  if (current.sessionId === pendingSessionId) return current.status !== "completed";
  return !["running", "waiting", "completed"].includes(current.status);
}

export function auditRecommendationFollowup(recommendations: string[], requireReport = true): string {
  const items = recommendations.map((item, index) => `${index + 1}. ${JSON.stringify(item)}`).join("\n");
  const report = requireReport
    ? " After implementation and validation, create a durable post-remediation report describing each recommendation, the change made, validation evidence, residual risk, and any justified blocker."
    : "";
  return `This task is an audit and its completion report contains actionable recommendations. Do not start a new task and do not stop at recommendations. Implement the following recommendations in this same task within the current workspace:\n${items}\n\nValidate every implemented recommendation and accurately report any item that requires unavailable authority or cannot be completed safely.${report} Do not claim completion until this remediation work is finished.`;
}

export function completionVerificationFollowup(repeatedAfterImplementation = false, confidenceThreshold = 90): string {
  const reason = repeatedAfterImplementation
    ? "The previous verification pass made implementation changes, so verify the resulting implementation again."
    : "Before this task is accepted as complete, perform one final completion verification.";
  return `${reason} Stay in this exact same task and do not spawn a new task. Re-read the original request and verify every acceptance criterion and material requirement against concrete implementation and validation evidence. Check that tests actually completed, documentation and configuration agree with behavior, and no requested work remains pending, deferred, or merely described.\n\nEnd the completion report with exactly one line in the form COMPLETION_CONFIDENCE: N%, where N is your evidence-based confidence from 0 to 100. A confidence of at least ${confidenceThreshold}% allows the queue to proceed even if this verification made justified implementation changes. Do not inflate the score: unresolved requirements, failed or unrun required validation, or material uncertainty must keep it below the threshold.\n\nIf verification finds a defect or omission, implement the correction and validate it, then complete again. If no implementation change is needed, state that all criteria are met with concise evidence and complete without making cosmetic or unnecessary edits.`;
}

export type CompletionVerificationDecision = "request_initial" | "request_after_implementation" | "accept";

export function completionVerificationDecision(requested: boolean, implementationActivity: boolean, confidence?: number, threshold = 90, verificationRounds = 0, maxVerificationRounds = 3): CompletionVerificationDecision {
  if (!requested) return "request_initial";
  if (confidence !== undefined && confidence >= threshold) return "accept";
  if (!implementationActivity) return "accept";
  return verificationRounds >= maxVerificationRounds ? "accept" : "request_after_implementation";
}

export function extractCompletionConfidence(text?: string): number | undefined {
  const matches = [...(text ?? "").matchAll(/^\s*COMPLETION_CONFIDENCE\s*:\s*(100|\d{1,2})\s*%\s*$/gim)];
  return matches.length ? Number(matches.at(-1)![1]) : undefined;
}

export async function deliverTaskBoundMessage(adapter: ClineAdapter, sessionId: string, message: string, purpose: string, signal: AbortSignal, owned: boolean, selectSession = true, stabilityMs = DISPATCH_STABILITY_DELAY_MS, timeoutMs = POLICY_MESSAGE_TIMEOUT_MS): Promise<void> {
  if (!owned) throw new ClineConsoleError("UNOWNED_CLINE_TASK", `Refusing to send ${purpose} to Cline session ${sessionId}: the session is not owned by cline-console.`);
  if (signal.aborted) throw new Error(`Queue monitor stopped before ${purpose}.`);
  if (selectSession) {
    if (!adapter.resumeTask) throw new ClineConsoleError("CLINE_API_UNSUPPORTED", `Native task selection is unavailable; refusing to send ${purpose} to an implicitly active Cline thread.`);
    await withAbortableTimeout(adapter.resumeTask(sessionId), signal, timeoutMs, `Timed out selecting Cline session ${sessionId} for ${purpose}.`, `Queue monitor stopped while selecting Cline session ${sessionId} for ${purpose}.`);
    await abortableDelay(stabilityMs, signal);
    if (signal.aborted) throw new Error("Queue monitor stopped before task-bound message delivery.");
  }
  await withAbortableTimeout(adapter.sendMessage(message), signal, timeoutMs, `Timed out delivering ${purpose} to Cline session ${sessionId}.`, `Queue monitor stopped while delivering ${purpose} to Cline session ${sessionId}.`);
}

export function newTaskHandoffFollowup(proposedContext?: string): string {
  const context = proposedContext?.trim() ? `\n\nCline proposed this handoff context. Treat it as remaining work in this thread:\n${proposedContext.trim()}` : "";
  return `${SAME_THREAD_ACK_MARKER}\nDo not start or spawn a new task. Continue the current original task in this exact same Cline thread. Finish all remaining work, including implementation, tests, validation, remediation, documentation, and the final task report.${context}\n\nDo not request another new task. Continue until every in-scope completion criterion from the original prompt and this handoff context is satisfied.`;
}

export function newTaskHandoffKey(sessionId: string, proposedContext?: string): string {
  const normalized = proposedContext?.toLocaleLowerCase().replace(/\s+/g, " ").trim() ?? "";
  return `${sessionId}:${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export function newTaskHandoffPolicy(repeatCount: number, alreadyCompacted: boolean): "continue" | "compact" | "suppress" {
  if (alreadyCompacted) return "suppress";
  return repeatCount >= 3 ? "compact" : "continue";
}

export function reflectiveCompletionFollowup(taskId: string): string {
  return `Reflect on the implementation work you just completed in this same task. Produce a concise report covering difficulties, obstacles, blockers, failed approaches, important tradeoffs, surprising behavior, and lessons that would improve a future attempt. Distinguish resolved problems from unresolved risks and do not invent difficulties that did not occur.\n\nPrefer storing the report as Markdown at .cline-console/reflections/${taskId}.md within the workspace. If writing that file is inappropriate or unavailable, include the complete Markdown report in your completion response; cline-console will preserve that response in its history database. Validate factual claims, then complete this same task without spawning a new task.`;
}

export function scopeViolationFollowup(scopePath: string, violatingPaths: string[]): string {
  const paths = violatingPaths.length ? `\nDetected out-of-scope edits:\n${violatingPaths.map(value => `- ${value}`).join("\n")}` : "";
  return `STOP: this task is restricted to ${scopePath}. Do not modify files outside that path.${paths}\n\nContinue in this same task. Revert only the out-of-scope changes made by this task, preserve unrelated user changes, and complete the requested work entirely within the declared scope. Validate that subsequent edits remain inside the scope before completing.`;
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

function withAbortableTimeout<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs: number, timeoutMessage: string, abortMessage: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(abortMessage));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error(timeoutMessage))), timeoutMs);
    const abort = (): void => finish(() => reject(new Error(abortMessage)));
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      settle();
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}
