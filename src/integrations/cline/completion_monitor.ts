import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../common/logging";
import type { ClineStatus } from "./types";
import { taskTitle } from "../../common/task_title";
import { findLatestContextOverflow } from "./context_overflow";

export interface CompletionResult { sessionId: string; status: string; exitCode?: number; errorText?: string; failureMarker?: string; testTimeoutMarker?: string; timedOutCommand?: string; completionText?: string; taskProgressText?: string; completionMarker?: string; recoveryMarker?: string; scopeViolationMarker?: string; violatingPaths?: string[]; implementationActivity?: boolean; userConfirmedDoneMarker?: string; }
export interface TaskCompletionMonitorOptions {
  deletionGraceMs?: number;
  pollIntervalMs?: number;
  terminalStabilityMs?: number;
  detectTestTimeouts?: boolean;
  knownSessionId?: string;
  currentSessionId?: () => string | undefined;
  afterCompletionMarker?: string;
  afterRecoveryMarker?: string;
  afterFailureMarker?: string;
  afterTestTimeoutMarker?: string;
  scopePath?: string;
  afterScopeViolationMarker?: string;
  onSessionObserved?: (sessionId: string) => void | Promise<void>;
  onActivityStatus?: (status: "running" | "waiting" | "completed", completionClaim: boolean) => void | Promise<void>;
}
export interface WorkspaceActivity { active: boolean; queueActive?: boolean; sessionId?: string; status?: "running" | "waiting" | "idle" | "completed" | "failed"; observedAt?: string; modelIdentity?: string; modelConflict?: { winnerWorkspace: string; modelIdentity: string; interruptedAt: string }; }
export interface WorkspaceSessionStatus { sessionId: string; status: string; observedAt: string; title?: string; exitCode?: number; errorText?: string; }
export interface WorkspaceTaskPrompt { sessionId: string; prompt: string; }
export interface NewTaskHandoff { sessionId: string; marker: string; text?: string; repeatCount: number; }
export const BRIDGE_SUBMISSION_GRACE_MS = 30_000;
export const UI_RUNNING_STALE_MS = 15 * 60_000;
export const MANUAL_COMPLETED_TASK_RESUME_GAP_MS = 5_000;
export const SAME_THREAD_ACK_MARKER = "[cline-console:same-thread-handoff]";
const SAME_THREAD_INSTRUCTION = /(?:finish|continue|remain|work)\s+(?:the\s+)?(?:current\s+)?(?:original\s+)?(?:task\s+)?in\s+this\s+(?:exact\s+)?(?:same\s+)?(?:Cline\s+)?thread/i;

function isSameThreadAcknowledgement(message: Record<string, unknown>): boolean {
  return typeof message.text === "string"
    && (message.text.includes(SAME_THREAD_ACK_MARKER) || SAME_THREAD_INSTRUCTION.test(message.text));
}

export async function getLegacyNewTaskHandoff(workspace: string, vscodeStorageOverride?: string): Promise<NewTaskHandoff | undefined> {
  const storage = vscodeStorageOverride || process.env.CLINE_VSCODE_STORAGE_DIR?.trim() || path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  try {
    const history = JSON.parse(await fs.readFile(path.join(storage, "state", "taskHistory.json"), "utf8")) as Array<Record<string, unknown>>;
    const entries = [...history].reverse().filter(item => item.cwdOnTaskInitialization === workspace && typeof item.id === "string").slice(0, 50);
    for (const [entryIndex, entry] of entries.entries()) {
      const sessionId = String(entry.id);
      const file = path.join(storage, "tasks", sessionId, "ui_messages.json");
      let messages: Array<Record<string, unknown>>;
      let metadata;
      try { [messages, metadata] = await Promise.all([fs.readFile(file, "utf8").then(raw => JSON.parse(raw)), fs.stat(file)]); }
      catch { continue; }
      // A predecessor may contain the handoff after Cline has already selected a
      // successor. Scan recent exact-workspace sessions so that rollover cannot
      // hide the request, while ignoring old historical handoffs.
      // The latest workspace task may remain parked at resume_task overnight;
      // its handoff is still actionable. Apply the age bound only to older
      // predecessor sessions discovered for rollover-race recovery.
      if (entryIndex > 0 && Date.now() - metadata.mtimeMs > UI_RUNNING_STALE_MS) continue;
      let handoffIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].ask === "new_task") { handoffIndex = index; break; }
      }
      if (handoffIndex < 0) continue;
      const alreadyRejected = messages.slice(handoffIndex + 1).some(isSameThreadAcknowledgement);
      if (alreadyRejected) continue;
      const handoff = messages[handoffIndex];
      const normalizedText = normalizeHandoffText(handoff.text);
      const repeatCount = messages.filter(message => message.ask === "new_task" && normalizeHandoffText(message.text) === normalizedText).length;
      return { sessionId, marker: `${sessionId}:${String(handoff.ts ?? handoffIndex)}`, repeatCount, ...(typeof handoff.text === "string" ? { text: handoff.text } : {}) };
    }
    return undefined;
  } catch { return undefined; }
}

function normalizeHandoffText(value: unknown): string {
  return typeof value === "string" ? value.toLocaleLowerCase().replace(/\s+/g, " ").trim() : "";
}

export async function waitForLegacyNewTaskHandoffAcknowledgement(handoff: NewTaskHandoff, signal: AbortSignal, vscodeStorageOverride?: string, timeoutMs = 10_000): Promise<boolean> {
  const storage = vscodeStorageOverride || process.env.CLINE_VSCODE_STORAGE_DIR?.trim() || path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  const file = path.join(storage, "tasks", handoff.sessionId, "ui_messages.json");
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() <= deadline) {
    try {
      const messages = JSON.parse(await fs.readFile(file, "utf8")) as Array<Record<string, unknown>>;
      const handoffIndex = messages.findIndex((message, index) => message.ask === "new_task" && `${handoff.sessionId}:${String(message.ts ?? index)}` === handoff.marker);
      if (handoffIndex >= 0 && messages.slice(handoffIndex + 1).some(isSameThreadAcknowledgement)) return true;
    } catch { /* The UI message file may be updating atomically. */ }
    await abortableDelay(Math.min(250, Math.max(0, deadline - Date.now())), signal);
  }
  return false;
}

export async function getLatestLegacyWorkspaceTaskPrompt(workspace: string, clineRootOverride?: string, vscodeStorageOverride?: string): Promise<WorkspaceTaskPrompt | undefined> {
  const clineRoot = clineRootOverride || process.env.CLINE_DIR?.trim() || path.join(os.homedir(), ".cline");
  const vscodeStorage = vscodeStorageOverride || process.env.CLINE_VSCODE_STORAGE_DIR?.trim() || path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  try {
    const history = JSON.parse(await fs.readFile(path.join(vscodeStorage, "state", "taskHistory.json"), "utf8")) as Array<Record<string, unknown>>;
    const entry = [...history].reverse().find(item => item.cwdOnTaskInitialization === workspace && typeof item.id === "string" && typeof item.task === "string" && item.task.length > 0);
    if (entry) return { sessionId: String(entry.id), prompt: String(entry.task) };
  } catch { /* Fall back to Cline's session metadata. */ }
  const directory = path.join(clineRoot, "data", "sessions");
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  names.sort().reverse();
  for (const name of names.slice(0, 200)) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, name, `${name}.json`), "utf8")) as Record<string, unknown>;
      if (value.source === "vscode" && value.workspace_root === workspace && typeof value.prompt === "string" && value.prompt.length > 0) {
        return { sessionId: typeof value.session_id === "string" ? value.session_id : name, prompt: value.prompt };
      }
    } catch { /* A session may be atomically updating while inspected. */ }
  }
  return undefined;
}

export async function getLegacyWorkspaceSessionStatus(workspace: string, clineRootOverride?: string, vscodeStorageOverride?: string): Promise<WorkspaceSessionStatus | undefined> {
  const clineRoot = clineRootOverride || process.env.CLINE_DIR?.trim() || path.join(os.homedir(), ".cline");
  const vscodeStorage = vscodeStorageOverride || process.env.CLINE_VSCODE_STORAGE_DIR?.trim() || path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  const uiTask = await getLegacyUiTaskStatus(workspace, vscodeStorage);
  const directory = path.join(clineRoot, "data", "sessions");
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return uiTask; throw error; }
  names.sort().reverse();
  for (const name of names.slice(0, 200)) {
    const session = await readSession(directory, name, workspace, true);
    if (session) {
      // A live PID is stronger evidence than an old UI message timestamp.
      if (session.status === "running") return session;
      return !uiTask || Date.parse(session.observedAt) > Date.parse(uiTask.observedAt) ? session : uiTask;
    }
  }
  return uiTask;
}

async function getLegacyUiTaskStatus(workspace: string, storage: string): Promise<WorkspaceSessionStatus | undefined> {
  try {
    const history = JSON.parse(await fs.readFile(path.join(storage, "state", "taskHistory.json"), "utf8")) as Array<Record<string, unknown>>;
    const entry = [...history].reverse().find(item => item.cwdOnTaskInitialization === workspace && typeof item.id === "string");
    if (!entry) return undefined;
    const sessionId = String(entry.id);
    const file = path.join(storage, "tasks", sessionId, "ui_messages.json");
    const [raw, metadata] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    const messages = JSON.parse(raw) as Array<Record<string, unknown>>;
    const last = messages.at(-1);
    if (!last) return undefined;
    const failure = findUnresolvedTaskFailure(messages, sessionId);
    // Cline may append resume_completed_task immediately while leaving a
    // completed thread. A substantially later, fresh control is different: it
    // records that the user manually reopened that exact thread. Treat that as
    // a model-acquisition signal so the cross-workspace arbiter can suspend a
    // competing queue before both workspaces submit inference concurrently.
    const previousCompletion = last.ask === "resume_completed_task"
      ? [...messages].reverse().find(message => message !== last && (message.ask === "completion_result" || message.say === "completion_result"))
      : undefined;
    const resumeAt = typeof last.ts === "number" ? last.ts : Number.NaN;
    const completionAt = typeof previousCompletion?.ts === "number" ? previousCompletion.ts : Number.NaN;
    const delayedCompletedTaskResume = last.ask === "resume_completed_task"
      && Number.isFinite(resumeAt)
      && Number.isFinite(completionAt)
      && resumeAt - completionAt >= MANUAL_COMPLETED_TASK_RESUME_GAP_MS;
    const terminal = last.ask === "completion_result" || last.say === "completion_result" || (last.ask === "resume_completed_task" && !delayedCompletedTaskResume);
    const waiting = last.ask === "resume_task";
    const staleRunning = !failure && !terminal && !waiting && Date.now() - metadata.mtimeMs > UI_RUNNING_STALE_MS;
    return { sessionId, status: failure ? "failed" : terminal ? "completed" : waiting ? "waiting" : staleRunning ? "stale" : "running", observedAt: metadata.mtime.toISOString(), title: taskTitle(entry.task), ...(failure ? { errorText: failure.text } : {}) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return undefined; }
}

export function reconcileLegacyStatus(status: ClineStatus, session: WorkspaceSessionStatus | undefined, now = Date.now()): ClineStatus {
  const submittedAt = status.state === "submitted" && status.observedAt ? Date.parse(status.observedAt) : Number.NaN;
  const submissionIsFresh = Number.isFinite(submittedAt) && now - submittedAt <= BRIDGE_SUBMISSION_GRACE_MS;
  if (!session) {
    if (status.task === "active" && status.state === "submitted" && !submissionIsFresh) {
      return { ...status, task: "none", state: "unknown", taskId: undefined, title: undefined, detail: "Stale bridge submission expired without a matching Cline workspace task." };
    }
    return status;
  }
  if (status.task === "active" && status.state === "submitted" && submissionIsFresh && submittedAt > Date.parse(session.observedAt)) {
    return { ...status, title: session.title ?? status.title, detail: "Active bridge submission is newer than Cline's latest workspace session metadata." };
  }
  if (session.status === "running") return { ...status, task: "active", state: "running", taskId: session.sessionId, title: session.title, detail: "Status reconciled from Cline's latest workspace session metadata." };
  if (session.status === "stale") return { ...status, task: "none", state: "idle", taskId: undefined, title: undefined, detail: "No task is running in this workspace." };
  if (session.status === "waiting") return { ...status, task: "active", state: "waiting", taskId: session.sessionId, title: session.title, detail: "Task is incomplete and waiting for Cline's resume action." };
  if (session.status === "failed" || (session.exitCode !== undefined && session.exitCode !== 0)) return { ...status, task: "failed", state: "failed", taskId: session.sessionId, title: session.title, detail: session.errorText ?? "Status reconciled from Cline's latest workspace session metadata." };
  if (session.status === "idle" || session.status === "completed") return { ...status, task: "completed", state: session.status, taskId: session.sessionId, title: session.title, detail: "Status reconciled from Cline's latest workspace session metadata." };
  return { ...status, task: "unknown", state: "unknown", taskId: session.sessionId, title: session.title, detail: `Latest Cline session has unrecognized status '${session.status}'.` };
}

export async function getLegacyWorkspaceActivity(workspace: string, clineRootOverride?: string, vscodeStorageOverride?: string): Promise<WorkspaceActivity> {
  const session = await getLegacyWorkspaceSessionStatus(workspace, clineRootOverride, vscodeStorageOverride);
  if (!session || !(["running", "waiting", "idle", "completed", "failed"] as string[]).includes(session.status)) return { active: false };
  return { active: true, sessionId: session.sessionId, status: session.status as WorkspaceActivity["status"], observedAt: session.observedAt };
}

/**
 * Resolve live activity from sessions already owned by a workspace queue.
 *
 * Cline can temporarily omit a newly created/recovered task from its shared
 * taskHistory.json while continuing to update that task's UI transcript.  A
 * queue already has stronger attribution: its durable owned session IDs and
 * the exact prompt of its running item.  Use those two facts to keep model
 * arbitration accurate without ever adopting an unrelated Cline task.
 */
export async function getOwnedLegacyTaskActivity(
  sessionIds: readonly string[],
  prompt: string,
  vscodeStorageOverride?: string,
  observedAfter?: string
): Promise<WorkspaceActivity | undefined> {
  const storage = vscodeStorageOverride || process.env.CLINE_VSCODE_STORAGE_DIR?.trim() || path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  const candidates: Array<WorkspaceActivity & { modifiedAt: number }> = [];
  const observedAfterMs = observedAfter ? Date.parse(observedAfter) : Number.NaN;
  for (const sessionId of [...new Set(sessionIds)].slice(-200)) {
    const file = path.join(storage, "tasks", sessionId, "ui_messages.json");
    try {
      const [raw, metadata] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
      if (Number.isFinite(observedAfterMs) && metadata.mtimeMs < observedAfterMs) continue;
      const messages = JSON.parse(raw) as Array<Record<string, unknown>>;
      const taskMessage = messages.find(message => message.say === "task" && typeof message.text === "string");
      if (taskMessage?.text !== prompt) continue;
      const last = messages.at(-1);
      if (!last) continue;
      const failure = findUnresolvedTaskFailure(messages, sessionId);
      const completed = last.ask === "completion_result" || last.say === "completion_result";
      const waiting = last.ask === "resume_task";
      const staleRunning = !failure && !completed && !waiting && Date.now() - metadata.mtimeMs > UI_RUNNING_STALE_MS;
      candidates.push({
        active: !staleRunning,
        sessionId,
        status: failure ? "failed" : completed ? "completed" : waiting ? "waiting" : staleRunning ? "idle" : "running",
        observedAt: metadata.mtime.toISOString(),
        modifiedAt: metadata.mtimeMs
      });
    } catch { /* An owned session may have been pruned or atomically rewritten. */ }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const selected = candidates[0];
  if (!selected) return undefined;
  const { modifiedAt: _modifiedAt, ...activity } = selected;
  return activity;
}

export async function waitForLegacyMessageCompletion(workspace: string, sessionId: string, signal: AbortSignal, logger: Logger, clineRootOverride?: string): Promise<CompletionResult> {
  const clineRoot = clineRootOverride || process.env.CLINE_DIR?.trim() || path.join(os.homedir(), ".cline");
  const sessions = path.join(clineRoot, "data", "sessions");
  const runningDeadline = Date.now() + 15_000;
  let observedRunning = false;
  while (!signal.aborted) {
    const result = await readSession(sessions, sessionId, workspace);
    if (result?.status === "running") observedRunning = true;
    if (result && result.status !== "running" && (observedRunning || Date.now() >= runningDeadline)) {
      logger.info(`Cline session ${sessionId} reached ${result.status} after queued message delivery.`);
      return result;
    }
    await abortableDelay(1_000, signal);
  }
  throw new Error("Queue monitor stopped.");
}

async function readSession(directory: string, sessionId: string, workspace: string, requireLiveRunning = false): Promise<WorkspaceSessionStatus | undefined> {
  try {
    const file = path.join(directory, sessionId, `${sessionId}.json`);
    const [raw, metadata] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.source !== "vscode" || value.workspace_root !== workspace) return undefined;
    if (requireLiveRunning && value.status === "running" && !processExists(value.pid)) return undefined;
    return { sessionId, status: String(value.status), observedAt: metadata.mtime.toISOString(), title: taskTitle(value.prompt), ...(typeof value.exit_code === "number" ? { exitCode: value.exit_code } : {}) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return undefined; }
}

export async function waitForLegacyWorkspaceIdle(workspace: string, signal: AbortSignal, logger: Logger, clineRootOverride?: string, isWaitingTaskIgnored: (sessionId: string) => boolean = () => false, vscodeStorageOverride?: string): Promise<void> {
  let announced = false;
  while (!signal.aborted) {
    const current = await getLegacyWorkspaceSessionStatus(workspace, clineRootOverride, vscodeStorageOverride);
    if (current?.status !== "running" && current?.status !== "waiting") return;
    // A queue-owned session can remain reported as `running` by Cline's
    // workspace metadata after the completion monitor has already accepted
    // and persisted its terminal result.  The queue supplies only explicitly
    // finalized/overridden session IDs here, so allow either stale busy state
    // to be ignored instead of blocking the next item forever.
    if (isWaitingTaskIgnored(current.sessionId)) return;
    if (!announced) { logger.info(`Queue waiting for existing Cline session ${current.sessionId} in ${workspace}.`); announced = true; }
    await abortableDelay(5_000, signal);
  }
  // Queue clear/stop deliberately aborts this pre-dispatch wait. Treat that
  // control-flow signal as a clean shutdown so the first clear request cannot
  // inherit an expected monitor cancellation as an INTERNAL_ERROR.
}

export async function waitForLegacyWorkspaceIdleStability(workspace: string, stabilityMs: number, signal: AbortSignal, logger: Logger, clineRootOverride?: string, isWaitingTaskIgnored: (sessionId: string) => boolean = () => false, vscodeStorageOverride?: string, pollIntervalMs = 1_000): Promise<void> {
  let idleSince: number | undefined;
  let announced = false;
  while (!signal.aborted) {
    const current = await getLegacyWorkspaceSessionStatus(workspace, clineRootOverride, vscodeStorageOverride);
    const busy = current !== undefined
      && (current.status === "running" || current.status === "waiting")
      && !isWaitingTaskIgnored(current.sessionId);
    if (busy) {
      idleSince = undefined;
      if (!announced) { logger.info(`Restart recovery is waiting for Cline session ${current!.sessionId} in ${workspace} to become idle.`); announced = true; }
    } else {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= stabilityMs) return;
    }
    await abortableDelay(Math.min(pollIntervalMs, Math.max(1, stabilityMs)), signal);
  }
}

export async function waitForLegacyTaskCompletion(workspace: string, prompt: string, dispatchedAt: string, signal: AbortSignal, logger: Logger, clineRootOverride?: string, vscodeStorageOverride?: string, options: TaskCompletionMonitorOptions = {}): Promise<CompletionResult> {
  const clineRoot = clineRootOverride || process.env.CLINE_DIR?.trim() || path.join(os.homedir(), ".cline");
  const vscodeStorage = vscodeStorageOverride || process.env.CLINE_VSCODE_STORAGE_DIR?.trim() || path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  const sessions = path.join(clineRoot, "data", "sessions");
  const earliest = Date.parse(dispatchedAt) - 5_000;
  const deletionGraceMs = options.deletionGraceMs ?? 15_000;
  let deletionDeadline = Date.now() + deletionGraceMs;
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const terminalStabilityMs = options.terminalStabilityMs ?? 15_000;
  let observedUiSessionId = options.knownSessionId;
  let terminalCandidate: { key: string; firstObservedAt: number; result: CompletionResult } | undefined;
  while (!signal.aborted) {
    const currentSessionId = options.currentSessionId?.();
    if (currentSessionId && currentSessionId !== observedUiSessionId) {
      logger.info(`Cline completion monitor adopted session ${currentSessionId} from ${observedUiSessionId ?? "unbound"}.`);
      observedUiSessionId = currentSessionId;
      terminalCandidate = undefined;
      deletionDeadline = Date.now() + deletionGraceMs;
    }
    const uiLookup = await findMatchingUiTask(vscodeStorage, workspace, prompt, earliest, observedUiSessionId, options.afterCompletionMarker, options.afterRecoveryMarker, options.afterFailureMarker, options.afterTestTimeoutMarker, options.detectTestTimeouts ?? true);
    const uiMatch = uiLookup.match;
    if (uiMatch && uiMatch.sessionId !== observedUiSessionId) {
      observedUiSessionId = uiMatch.sessionId;
      await options.onSessionObserved?.(uiMatch.sessionId);
    }
    if (uiMatch?.status === "context_overflow" || uiMatch?.status === "task_failed" || uiMatch?.status === "test_timeout" || uiMatch?.status === "user_confirmed_done") return uiMatch;
    if (uiMatch && (uiMatch.status === "running" || uiMatch.status === "waiting" || uiMatch.status === "completed")) {
      await options.onActivityStatus?.(uiMatch.status, Boolean(uiMatch.completionMarker));
    }
    if (observedUiSessionId && options.scopePath) {
      const violation = await findScopeViolation(vscodeStorage, observedUiSessionId, workspace, options.scopePath, Date.parse(dispatchedAt));
      if (violation && violation.scopeViolationMarker !== options.afterScopeViolationMarker) return violation;
    }
    if (uiMatch) {
      if (uiMatch.status === "running" || uiMatch.status === "waiting" || uiMatch.completionMarker === options.afterCompletionMarker) terminalCandidate = undefined;
      else {
        terminalCandidate = updateTerminalCandidate(terminalCandidate, uiMatch, logger);
        if (Date.now() - terminalCandidate.firstObservedAt >= terminalStabilityMs) {
          logger.info(`Cline UI task ${uiMatch.sessionId} remained terminal for ${terminalStabilityMs}ms.`);
          return uiMatch;
        }
      }
    }
    if (uiLookup.historyAvailable && !uiMatch && observedUiSessionId !== undefined && Date.now() >= deletionDeadline) {
      logger.info(`Queued Cline task${observedUiSessionId ? ` ${observedUiSessionId}` : ""} disappeared from workspace history; skipping it.`);
      return { sessionId: observedUiSessionId ?? "", status: "deleted" };
    }
    // Once Cline's authoritative UI history is available, never use the
    // auxiliary session mirror to declare completion. It can report idle or
    // completed before Cline has either persisted the task or accepted its
    // final completion_result, which would jump over resumable tasks.
    const match = uiLookup.historyAvailable ? undefined : await findMatchingSession(sessions, workspace, prompt, earliest);
    if (match) {
      if (isTerminalStatus(match.status)) {
        terminalCandidate = updateTerminalCandidate(terminalCandidate, match, logger);
        if (Date.now() - terminalCandidate.firstObservedAt >= terminalStabilityMs) {
          logger.info(`Cline session ${match.sessionId} remained terminal for ${terminalStabilityMs}ms.`);
          return match;
        }
      } else terminalCandidate = undefined;
    }
    await abortableDelay(pollIntervalMs, signal);
  }
  throw new Error("Queue monitor stopped.");
}

async function findScopeViolation(storage: string, sessionId: string, workspace: string, scopePath: string, dispatchedAt: number): Promise<CompletionResult | undefined> {
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(storage, "tasks", sessionId, "task_metadata.json"), "utf8")) as { files_in_context?: Array<Record<string, unknown>> };
    const scope = path.resolve(scopePath);
    const violatingPaths = [...new Set((metadata.files_in_context ?? []).flatMap(record => {
      const editedAt = typeof record.cline_edit_date === "number" ? record.cline_edit_date : undefined;
      if (!editedAt || editedAt < dispatchedAt || typeof record.path !== "string") return [];
      const candidate = path.resolve(workspace, record.path);
      return candidate === scope || candidate.startsWith(`${scope}${path.sep}`) ? [] : [candidate];
    }))].sort();
    if (!violatingPaths.length) return undefined;
    return { sessionId, status: "scope_violation", violatingPaths, scopeViolationMarker: `${sessionId}:${violatingPaths.join("\0")}` };
  } catch { return undefined; }
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "idle" || status === "failed";
}

function updateTerminalCandidate(candidate: { key: string; firstObservedAt: number; result: CompletionResult } | undefined, result: CompletionResult, logger: Logger) {
  const key = `${result.sessionId}\0${result.status}\0${result.exitCode ?? ""}`;
  if (candidate?.key === key) return candidate;
  logger.info(`Cline task ${result.sessionId} reached ${result.status}; beginning terminal stability wait.`);
  return { key, firstObservedAt: Date.now(), result };
}

async function findMatchingUiTask(storage: string, workspace: string, prompt: string, earliest: number, knownSessionId?: string, afterCompletionMarker?: string, afterRecoveryMarker?: string, afterFailureMarker?: string, afterTestTimeoutMarker?: string, detectTestTimeouts = true): Promise<{ historyAvailable: boolean; match?: CompletionResult }> {
  try {
    const history = JSON.parse(await fs.readFile(path.join(storage, "state", "taskHistory.json"), "utf8")) as Array<Record<string, unknown>>;
    const workspaceEntries = history.filter(item => item.cwdOnTaskInitialization === workspace && typeof item.id === "string");
    const knownEntry = knownSessionId ? workspaceEntries.find(item => item.id === knownSessionId) : undefined;
    const recoveredSuccessor = knownSessionId && (afterFailureMarker || afterRecoveryMarker)
      ? [...workspaceEntries].reverse().find(item => item.task === prompt && Number(item.id) > Number(knownSessionId) && Number(item.id) >= earliest)
      : undefined;
    // Cline may replace a failed/compacted task with a new session while
    // preserving the original prompt. Once recovery is known, follow that
    // newer exact-workspace, exact-prompt session instead of remaining pinned
    // forever to the terminal predecessor.
    let entry = recoveredSuccessor ?? knownEntry ?? (!knownSessionId
      ? [...workspaceEntries].reverse().find(item => item.task === prompt && Number(item.id) >= earliest)
      : undefined);
    let messages: Array<Record<string, unknown>> | undefined;
    // taskHistory.json is shared by every VS Code workspace and Cline can
    // transiently rewrite it while another window starts a task.  A queued
    // task's own UI transcript is stronger identity evidence than absence from
    // that index.  Continue monitoring the known task when its transcript
    // still begins with the exact queued prompt; otherwise the queue can race
    // ahead and launch later items in parallel.
    if (!entry && knownSessionId) {
      try {
        messages = JSON.parse(await fs.readFile(path.join(storage, "tasks", knownSessionId, "ui_messages.json"), "utf8")) as Array<Record<string, unknown>>;
        const taskMessage = messages.find(message => message.say === "task" && typeof message.text === "string");
        if (taskMessage?.text === prompt) entry = { id: knownSessionId, cwdOnTaskInitialization: workspace, task: prompt };
      } catch { /* A genuinely deleted task has no surviving transcript. */ }
    }
    if (!entry) return { historyAvailable: true };
    const sessionId = String(entry.id);
    messages ??= JSON.parse(await fs.readFile(path.join(storage, "tasks", sessionId, "ui_messages.json"), "utf8")) as Array<Record<string, unknown>>;
    const last = messages.at(-1);
    if (!last) return { historyAvailable: true };
    const userConfirmedDone = findUserConfirmedDone(messages, sessionId, earliest);
    if (userConfirmedDone) {
      return { historyAvailable: true, match: { sessionId, status: "user_confirmed_done", userConfirmedDoneMarker: userConfirmedDone } };
    }
    const overflow = findLatestContextOverflow(messages, sessionId);
    if (overflow && overflow.marker !== afterRecoveryMarker) {
      return { historyAvailable: true, match: { sessionId, status: "context_overflow", recoveryMarker: overflow.marker } };
    }
    const failure = findUnresolvedTaskFailure(messages, sessionId);
    if (failure && failure.marker !== afterFailureMarker) {
      return { historyAvailable: true, match: { sessionId, status: "task_failed", errorText: failure.text, failureMarker: failure.marker } };
    }
    // A resume_completed_task control is written after completion_result and
    // must still drive the normal completion scanner/follow-up flow.
    const completed = last.ask === "completion_result" || last.say === "completion_result" || last.ask === "resume_completed_task";
    const waiting = last.ask === "resume_task";
    const testTimeout = completed && detectTestTimeouts ? findUnresolvedTestTimeout(messages, sessionId, String(last.ts ?? messages.length)) : undefined;
    if (testTimeout) {
      if (testTimeout.marker !== afterTestTimeoutMarker) return { historyAvailable: true, match: { sessionId, status: "test_timeout", testTimeoutMarker: testTimeout.marker, timedOutCommand: testTimeout.command, errorText: testTimeout.text } };
      return { historyAvailable: true, match: { sessionId, status: "waiting" } };
    }
    const completion = completed ? [...messages].reverse().find(message =>
      (message.ask === "completion_result" || message.say === "completion_result")
        && typeof message.text === "string"
        && message.text.trim().length > 0
    ) : undefined;
    const taskProgress = completed ? [...messages].reverse().find(message =>
      (message.ask === "task_progress" || message.say === "task_progress") && typeof message.text === "string"
    ) : undefined;
    const markerPart = String(last.ts ?? messages.length);
    return { historyAvailable: true, match: {
      sessionId,
      status: completed ? "completed" : waiting ? "waiting" : "running",
      ...(completed ? { completionMarker: `${sessionId}:${markerPart}` } : {}),
      ...(completed && afterCompletionMarker ? { implementationActivity: hasImplementationActivitySince(messages, afterCompletionMarker) } : {}),
      ...(typeof completion?.text === "string" ? { completionText: completion.text } : {}),
      ...(typeof taskProgress?.text === "string" ? { taskProgressText: taskProgress.text } : {})
    } };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { historyAvailable: false }; return { historyAvailable: false }; }
}

export function findUserConfirmedDone(messages: Array<Record<string, unknown>>, sessionId: string, earliest = Number.NEGATIVE_INFINITY): string | undefined {
  const match = [...messages].reverse().find(message => {
    const timestamp = typeof message.ts === "number" ? message.ts : Number(message.ts);
    return message.say === "user_feedback"
      && typeof message.text === "string"
      && message.text.trim().toUpperCase() === "DONE"
      && Number.isFinite(timestamp)
      && timestamp >= earliest;
  });
  return match ? `${sessionId}:${String(match.ts)}` : undefined;
}

export function hasImplementationActivitySince(messages: Array<Record<string, unknown>>, completionMarker: string): boolean {
  const markerPart = completionMarker.slice(completionMarker.lastIndexOf(":") + 1);
  const markerTimestamp = Number(markerPart);
  let markerIndex = -1;
  if (Number.isFinite(markerTimestamp)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (Number(messages[index].ts) <= markerTimestamp) { markerIndex = index; break; }
    }
    if (markerIndex < 0 && Number.isSafeInteger(markerTimestamp) && markerTimestamp >= 1 && markerTimestamp <= messages.length) markerIndex = markerTimestamp - 1;
  }
  return messages.slice(markerIndex + 1).some(message => {
    const text = typeof message.text === "string" ? message.text : "";
    if (/\[(?:write_to_file|replace_in_file|apply_diff|search_and_replace|insert_content|apply_patch)\b/i.test(text)) return true;
    const rawCommand = extractExecutedCommand(text);
    // Exclude only cleanup of the exact directory configured by this CMake
    // command. Keep all other mutations in the chain visible to the detector.
    const command = rawCommand
      ?.replace(/\brm\s+-rf\s+(build|cpp\/build)\s*&&(?=[^\n]*\bcmake\s+-S\s+\S+\s+-B\s+\1(?:\s|$))/g, "")
      .replace(/\brm\s+-rf\s+(\/[^\s;&|]+)\/build\s*&&\s*cd\s+\1\s+&&\s*(cmake\s+-S\s+\.\s+-B\s+build)(?=\s|$)/g, "cd $1 && $2");
    const normalized = command === undefined ? undefined : omitCompilerOutputCleanup(command);
    return normalized !== undefined && /(?:^|[;&|]\s*)(?:apply_patch\b|sed\b[^\n;&|]*\s-i(?:\s|$)|perl\b[^\n;&|]*\s-pi(?:\s|$)|(?:cp|mv|rm|mkdir|touch|install)\b|(?:npm|pnpm|yarn)\s+(?:install|add|remove)\b|(?:apt|apt-get|dnf|yum|pacman)\b|git\s+(?:add|commit|mv|rm|apply)\b)/i.test(normalized);
  });
}

function omitCompilerOutputCleanup(command: string): string {
  const outputs = new Set([...command.matchAll(/(?:^|[;&|]\s*)(?:g\+\+|clang\+\+|gcc|clang|cc|c\+\+)(?=\s)[^\n;&|]*?\s-o\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi)]
    .map(match => match[1] ?? match[2] ?? match[3]).filter(Boolean));
  let normalized = command;
  for (const output of outputs) {
    const escaped = output.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    normalized = normalized.replace(new RegExp(`(?:^|[;&|]\\s*)rm\\s+(?:-[a-zA-Z]*f[a-zA-Z]*\\s+)?(?:--\\s+)?(?:"${escaped}"|'${escaped}'|${escaped})(?=\\s*(?:$|[;&|]))`, "g"), "");
  }
  return normalized;
}

export function findUnresolvedTestTimeout(messages: Array<Record<string, unknown>>, sessionId: string, completionPart = "completion"): { marker: string; command: string; text: string } | undefined {
  const successful = new Set<string>();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = typeof messages[index].text === "string" ? messages[index].text as string : "";
    const command = extractExecutedCommand(text);
    if (!command || !isTestCommand(command)) continue;
    const signature = testCommandSignature(command);
    if (/\bCommand executed\.\s*(?:\r?\n)?Output:/i.test(text)) successful.add(signature);
    if (/\bCommand execution timed out after\s+\d+(?:\.\d+)?\s+seconds?\b/i.test(text) && !successful.has(signature)) {
      return { marker: `${sessionId}:${String(messages[index].ts ?? index)}:${completionPart}`, command, text: timeoutSummary(text) };
    }
  }
  return undefined;
}

function extractExecutedCommand(text: string): string | undefined {
  const match = text.match(/\[execute_command for '([\s\S]*?)'\]\s+Result:/i);
  return match?.[1].trim();
}

function isTestCommand(command: string): boolean {
  return /(?:^|[;&|\s])(?:python\d*\s+-m\s+)?pytest\b|\bpython\d*\s+-m\s+unittest\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\b(?:cargo|go|dotnet)\s+test\b|\bctest\b|\b(?:mvn|gradle)\b[^\n;&|]*\btest\b|\brspec\b/i.test(command);
}

function testCommandSignature(command: string): string {
  return command.toLowerCase().replace(/\btimeout\s+\S+\s+/g, "").replace(/\s+(?:2?>&?1|[|>]\s*[^;&]+).*$/s, "").replace(/\s+/g, " ").trim();
}

function timeoutSummary(text: string): string {
  return text.match(/Command execution timed out after\s+\d+(?:\.\d+)?\s+seconds?\.?/i)?.[0] ?? "Test command timed out.";
}

function findUnresolvedTaskFailure(messages: Array<Record<string, unknown>>, sessionId: string): { marker: string; text: string } | undefined {
  let candidate: { index: number; marker: string; text: string } | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = yoloFailureText(messages[index]);
    if (text) { candidate = { index, marker: `${sessionId}:${String(messages[index].ts ?? index)}`, text }; break; }
  }
  if (!candidate) return undefined;

  let recoveryRequested = false;
  for (const message of messages.slice(candidate.index + 1)) {
    if (message.ask === "completion_result" || message.say === "completion_result") return undefined;
    if (message.ask === "resume_task" || message.say === "user_feedback") recoveryRequested = true;
    if (recoveryRequested && message.say === "api_req_started") return undefined;
  }
  return candidate;
}

function yoloFailureText(message: Record<string, unknown>): string | undefined {
  // Ordinary source code and tool output frequently contain "task failed".
  // Only Cline error-channel records are eligible failure signals.
  if (message.say !== "error" && message.type !== "error") return undefined;
  const texts = collectErrorStrings(message);
  const match = texts.find(text =>
    /\[?YOLO MODE\]?[\s\S]{0,160}(?:task\s+failed|stopp?ed|aborted|disabled|consecutive\s+mistakes)/i.test(text)
    || /(?:too\s+many|maximum(?:\s+number\s+of)?|limit(?:\s+of)?)[\s\S]{0,80}consecutive\s+mistakes/i.test(text)
    || /consecutive\s+mistakes[\s\S]{0,80}(?:too\s+many|maximum|limit|task\s+failed|stopp?ed|aborted)/i.test(text)
  );
  return match?.trim();
}

function collectErrorStrings(value: unknown, depth = 0): string[] {
  if (depth > 3 || value === null || value === undefined) return [];
  if (typeof value === "string") {
    const texts = [value];
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 100_000) {
      try { texts.push(...collectErrorStrings(JSON.parse(trimmed), depth + 1)); } catch { /* Plain error text. */ }
    }
    return texts;
  }
  if (Array.isArray(value)) return value.flatMap(item => collectErrorStrings(item, depth + 1));
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap(item => collectErrorStrings(item, depth + 1));
  return [];
}

async function findMatchingSession(directory: string, workspace: string, prompt: string, earliest: number): Promise<CompletionResult | undefined> {
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  names.sort().reverse();
  for (const name of names.slice(0, 200)) {
    try {
      const raw = await fs.readFile(path.join(directory, name, `${name}.json`), "utf8");
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (value.source !== "vscode" || value.workspace_root !== workspace || value.prompt !== prompt) continue;
      if (Date.parse(String(value.started_at)) < earliest) continue;
      return { sessionId: String(value.session_id), status: String(value.status), ...(typeof value.exit_code === "number" ? { exitCode: value.exit_code } : {}) };
    } catch { /* A session may be atomically updating while inspected. */ }
  }
  return undefined;
}

function processExists(value: unknown): boolean {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return false;
  try { process.kill(value, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
