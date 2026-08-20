import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../common/logging";
import type { ClineStatus } from "./types";
import { taskTitle } from "../../common/task_title";
import { findLatestContextOverflow } from "./context_overflow";

export interface CompletionResult { sessionId: string; status: string; exitCode?: number; errorText?: string; failureMarker?: string; testTimeoutMarker?: string; timedOutCommand?: string; completionText?: string; taskProgressText?: string; completionMarker?: string; recoveryMarker?: string; }
export interface TaskCompletionMonitorOptions {
  deletionGraceMs?: number;
  pollIntervalMs?: number;
  terminalStabilityMs?: number;
  knownSessionId?: string;
  afterCompletionMarker?: string;
  afterRecoveryMarker?: string;
  afterFailureMarker?: string;
  afterTestTimeoutMarker?: string;
  onSessionObserved?: (sessionId: string) => void | Promise<void>;
}
export interface WorkspaceActivity { active: boolean; sessionId?: string; status?: "running" | "waiting" | "idle" | "completed" | "failed"; }
export interface WorkspaceSessionStatus { sessionId: string; status: string; observedAt: string; title?: string; exitCode?: number; errorText?: string; }
export interface WorkspaceTaskPrompt { sessionId: string; prompt: string; }
export interface NewTaskHandoff { sessionId: string; marker: string; text?: string; }
export const BRIDGE_SUBMISSION_GRACE_MS = 30_000;

export async function getLegacyNewTaskHandoff(workspace: string, vscodeStorageOverride?: string): Promise<NewTaskHandoff | undefined> {
  const storage = vscodeStorageOverride || process.env.CLINE_VSCODE_STORAGE_DIR?.trim() || path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  try {
    const history = JSON.parse(await fs.readFile(path.join(storage, "state", "taskHistory.json"), "utf8")) as Array<Record<string, unknown>>;
    const entry = [...history].reverse().find(item => item.cwdOnTaskInitialization === workspace && typeof item.id === "string");
    if (!entry) return undefined;
    const sessionId = String(entry.id);
    const messages = JSON.parse(await fs.readFile(path.join(storage, "tasks", sessionId, "ui_messages.json"), "utf8")) as Array<Record<string, unknown>>;
    let handoffIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].ask === "new_task") { handoffIndex = index; break; }
    }
    if (handoffIndex < 0) return undefined;
    const alreadyRejected = messages.slice(handoffIndex + 1).some(message => typeof message.text === "string" && message.text.includes("Finish in this thread."));
    if (alreadyRejected) return undefined;
    const handoff = messages[handoffIndex];
    return { sessionId, marker: `${sessionId}:${String(handoff.ts ?? handoffIndex)}`, ...(typeof handoff.text === "string" ? { text: handoff.text } : {}) };
  } catch { return undefined; }
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
    if (session) return !uiTask || Date.parse(session.observedAt) > Date.parse(uiTask.observedAt) ? session : uiTask;
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
    const terminal = last.ask === "completion_result" || last.say === "completion_result";
    const waiting = last.ask === "resume_task";
    return { sessionId, status: failure ? "failed" : terminal ? "completed" : waiting ? "waiting" : "running", observedAt: metadata.mtime.toISOString(), title: taskTitle(entry.task), ...(failure ? { errorText: failure.text } : {}) };
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
  if (session.status === "waiting") return { ...status, task: "active", state: "waiting", taskId: session.sessionId, title: session.title, detail: "Task is incomplete and waiting for Cline's resume action." };
  if (session.status === "failed" || (session.exitCode !== undefined && session.exitCode !== 0)) return { ...status, task: "failed", state: "failed", taskId: session.sessionId, title: session.title, detail: session.errorText ?? "Status reconciled from Cline's latest workspace session metadata." };
  if (session.status === "idle" || session.status === "completed") return { ...status, task: "completed", state: session.status, taskId: session.sessionId, title: session.title, detail: "Status reconciled from Cline's latest workspace session metadata." };
  return { ...status, task: "unknown", state: "unknown", taskId: session.sessionId, title: session.title, detail: `Latest Cline session has unrecognized status '${session.status}'.` };
}

export async function getLegacyWorkspaceActivity(workspace: string, clineRootOverride?: string): Promise<WorkspaceActivity> {
  const session = await getLegacyWorkspaceSessionStatus(workspace, clineRootOverride);
  if (!session || !(["running", "waiting", "idle", "completed", "failed"] as string[]).includes(session.status)) return { active: false };
  return { active: true, sessionId: session.sessionId, status: session.status as WorkspaceActivity["status"] };
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
    if (current.status === "waiting" && isWaitingTaskIgnored(current.sessionId)) return;
    if (!announced) { logger.info(`Queue waiting for existing Cline session ${current.sessionId} in ${workspace}.`); announced = true; }
    await abortableDelay(5_000, signal);
  }
  throw new Error("Queue monitor stopped.");
}

export async function waitForLegacyTaskCompletion(workspace: string, prompt: string, dispatchedAt: string, signal: AbortSignal, logger: Logger, clineRootOverride?: string, vscodeStorageOverride?: string, options: TaskCompletionMonitorOptions = {}): Promise<CompletionResult> {
  const clineRoot = clineRootOverride || process.env.CLINE_DIR?.trim() || path.join(os.homedir(), ".cline");
  const vscodeStorage = vscodeStorageOverride || process.env.CLINE_VSCODE_STORAGE_DIR?.trim() || path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  const sessions = path.join(clineRoot, "data", "sessions");
  const earliest = Date.parse(dispatchedAt) - 5_000;
  const deletionDeadline = Date.now() + (options.deletionGraceMs ?? 15_000);
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const terminalStabilityMs = options.terminalStabilityMs ?? 30_000;
  let observedUiSessionId = options.knownSessionId;
  let terminalCandidate: { key: string; firstObservedAt: number; result: CompletionResult } | undefined;
  while (!signal.aborted) {
    const uiLookup = await findMatchingUiTask(vscodeStorage, workspace, prompt, earliest, observedUiSessionId, options.afterRecoveryMarker, options.afterFailureMarker, options.afterTestTimeoutMarker);
    const uiMatch = uiLookup.match;
    if (uiMatch && uiMatch.sessionId !== observedUiSessionId) {
      observedUiSessionId = uiMatch.sessionId;
      await options.onSessionObserved?.(uiMatch.sessionId);
    }
    if (uiMatch?.status === "context_overflow" || uiMatch?.status === "task_failed" || uiMatch?.status === "test_timeout") return uiMatch;
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

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "idle" || status === "failed";
}

function updateTerminalCandidate(candidate: { key: string; firstObservedAt: number; result: CompletionResult } | undefined, result: CompletionResult, logger: Logger) {
  const key = `${result.sessionId}\0${result.status}\0${result.exitCode ?? ""}`;
  if (candidate?.key === key) return candidate;
  logger.info(`Cline task ${result.sessionId} reached ${result.status}; beginning terminal stability wait.`);
  return { key, firstObservedAt: Date.now(), result };
}

async function findMatchingUiTask(storage: string, workspace: string, prompt: string, earliest: number, knownSessionId?: string, afterRecoveryMarker?: string, afterFailureMarker?: string, afterTestTimeoutMarker?: string): Promise<{ historyAvailable: boolean; match?: CompletionResult }> {
  try {
    const history = JSON.parse(await fs.readFile(path.join(storage, "state", "taskHistory.json"), "utf8")) as Array<Record<string, unknown>>;
    const entry = [...history].reverse().find(item => item.cwdOnTaskInitialization === workspace && typeof item.id === "string" && (
      knownSessionId ? item.id === knownSessionId : item.task === prompt && Number(item.id) >= earliest
    ));
    if (!entry) return { historyAvailable: true };
    const sessionId = String(entry.id);
    const messages = JSON.parse(await fs.readFile(path.join(storage, "tasks", sessionId, "ui_messages.json"), "utf8")) as Array<Record<string, unknown>>;
    const last = messages.at(-1);
    if (!last) return { historyAvailable: true };
    const overflow = findLatestContextOverflow(messages, sessionId);
    if (overflow && overflow.marker !== afterRecoveryMarker) {
      return { historyAvailable: true, match: { sessionId, status: "context_overflow", recoveryMarker: overflow.marker } };
    }
    const failure = findUnresolvedTaskFailure(messages, sessionId);
    if (failure && failure.marker !== afterFailureMarker) {
      return { historyAvailable: true, match: { sessionId, status: "task_failed", errorText: failure.text, failureMarker: failure.marker } };
    }
    const completed = last.ask === "completion_result" || last.say === "completion_result";
    const waiting = last.ask === "resume_task";
    const testTimeout = completed ? findUnresolvedTestTimeout(messages, sessionId, String(last.ts ?? messages.length)) : undefined;
    if (testTimeout) {
      if (testTimeout.marker !== afterTestTimeoutMarker) return { historyAvailable: true, match: { sessionId, status: "test_timeout", testTimeoutMarker: testTimeout.marker, timedOutCommand: testTimeout.command, errorText: testTimeout.text } };
      return { historyAvailable: true, match: { sessionId, status: "waiting" } };
    }
    const completion = completed ? [...messages].reverse().find(message =>
      (message.ask === "completion_result" || message.say === "completion_result") && typeof message.text === "string"
    ) : undefined;
    const taskProgress = completed ? [...messages].reverse().find(message =>
      (message.ask === "task_progress" || message.say === "task_progress") && typeof message.text === "string"
    ) : undefined;
    const markerPart = String(last.ts ?? messages.length);
    return { historyAvailable: true, match: {
      sessionId,
      status: completed ? "completed" : waiting ? "waiting" : "running",
      ...(completed ? { completionMarker: `${sessionId}:${markerPart}` } : {}),
      ...(typeof completion?.text === "string" ? { completionText: completion.text } : {}),
      ...(typeof taskProgress?.text === "string" ? { taskProgressText: taskProgress.text } : {})
    } };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { historyAvailable: false }; return { historyAvailable: false }; }
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
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.say === "api_req_started" || message.say === "user_feedback" || message.ask === "completion_result" || message.say === "completion_result") return undefined;
    if (message.say === "error" && typeof message.text === "string" && /\bTask failed\s*:/i.test(message.text)) {
      return { marker: `${sessionId}:${String(message.ts ?? index)}`, text: message.text };
    }
  }
  return undefined;
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
