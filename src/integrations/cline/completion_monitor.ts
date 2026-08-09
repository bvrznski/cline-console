import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../common/logging";
import type { ClineStatus } from "./types";

export interface CompletionResult { sessionId: string; status: string; exitCode?: number; }
export interface WorkspaceActivity { active: boolean; sessionId?: string; status?: "running" | "idle" | "completed" | "failed"; }
export interface WorkspaceSessionStatus { sessionId: string; status: string; observedAt: string; title?: string; exitCode?: number; }

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
    const terminal = last.ask === "completion_result" || last.say === "completion_result";
    return { sessionId, status: terminal ? "completed" : "running", observedAt: metadata.mtime.toISOString(), title: firstLine(entry.task) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return undefined; }
}

export function reconcileLegacyStatus(status: ClineStatus, session: WorkspaceSessionStatus | undefined): ClineStatus {
  if (!session) return status;
  if (status.task === "active" && status.state === "submitted" && status.observedAt && Date.parse(status.observedAt) > Date.parse(session.observedAt)) {
    return { ...status, title: session.title ?? status.title, detail: "Active bridge submission is newer than Cline's latest workspace session metadata." };
  }
  if (session.status === "running") return { ...status, task: "active", state: "running", taskId: session.sessionId, title: session.title, detail: "Status reconciled from Cline's latest workspace session metadata." };
  if (session.status === "failed" || (session.exitCode !== undefined && session.exitCode !== 0)) return { ...status, task: "failed", state: "failed", taskId: session.sessionId, title: session.title, detail: "Status reconciled from Cline's latest workspace session metadata." };
  if (session.status === "idle" || session.status === "completed") return { ...status, task: "completed", state: session.status, taskId: session.sessionId, title: session.title, detail: "Status reconciled from Cline's latest workspace session metadata." };
  return { ...status, task: "unknown", state: "unknown", taskId: session.sessionId, title: session.title, detail: `Latest Cline session has unrecognized status '${session.status}'.` };
}

export async function getLegacyWorkspaceActivity(workspace: string, clineRootOverride?: string): Promise<WorkspaceActivity> {
  const session = await getLegacyWorkspaceSessionStatus(workspace, clineRootOverride);
  if (!session || !(["running", "idle", "completed", "failed"] as string[]).includes(session.status)) return { active: false };
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
    return { sessionId, status: String(value.status), observedAt: metadata.mtime.toISOString(), title: firstLine(value.prompt), ...(typeof value.exit_code === "number" ? { exitCode: value.exit_code } : {}) };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return undefined; }
}

function firstLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const line = value.split(/\r?\n/, 1)[0].trim();
  return line || undefined;
}

export async function waitForLegacyWorkspaceIdle(workspace: string, signal: AbortSignal, logger: Logger, clineRootOverride?: string): Promise<void> {
  let announced = false;
  while (!signal.aborted) {
    const current = await getLegacyWorkspaceSessionStatus(workspace, clineRootOverride);
    if (current?.status !== "running") return;
    if (!announced) { logger.info(`Queue waiting for existing Cline session ${current.sessionId} in ${workspace}.`); announced = true; }
    await abortableDelay(5_000, signal);
  }
  throw new Error("Queue monitor stopped.");
}

export async function waitForLegacyTaskCompletion(workspace: string, prompt: string, dispatchedAt: string, signal: AbortSignal, logger: Logger, clineRootOverride?: string, vscodeStorageOverride?: string): Promise<CompletionResult> {
  const clineRoot = clineRootOverride || process.env.CLINE_DIR?.trim() || path.join(os.homedir(), ".cline");
  const vscodeStorage = vscodeStorageOverride || process.env.CLINE_VSCODE_STORAGE_DIR?.trim() || path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  const sessions = path.join(clineRoot, "data", "sessions");
  const earliest = Date.parse(dispatchedAt) - 5_000;
  while (!signal.aborted) {
    const uiMatch = await findMatchingUiTask(vscodeStorage, workspace, prompt, earliest);
    if (uiMatch && uiMatch.status !== "running") {
      logger.info(`Cline UI task ${uiMatch.sessionId} reached terminal status ${uiMatch.status}.`);
      return uiMatch;
    }
    const match = await findMatchingSession(sessions, workspace, prompt, earliest);
    if (match && match.status !== "running") {
      logger.info(`Cline session ${match.sessionId} reached terminal status ${match.status}.`);
      return match;
    }
    await abortableDelay(5_000, signal);
  }
  throw new Error("Queue monitor stopped.");
}

async function findMatchingUiTask(storage: string, workspace: string, prompt: string, earliest: number): Promise<CompletionResult | undefined> {
  try {
    const history = JSON.parse(await fs.readFile(path.join(storage, "state", "taskHistory.json"), "utf8")) as Array<Record<string, unknown>>;
    const entry = [...history].reverse().find(item =>
      item.cwdOnTaskInitialization === workspace && item.task === prompt && typeof item.id === "string" && Number(item.id) >= earliest
    );
    if (!entry) return undefined;
    const sessionId = String(entry.id);
    const messages = JSON.parse(await fs.readFile(path.join(storage, "tasks", sessionId, "ui_messages.json"), "utf8")) as Array<Record<string, unknown>>;
    const last = messages.at(-1);
    if (!last) return undefined;
    const completed = last.ask === "completion_result" || last.say === "completion_result";
    return { sessionId, status: completed ? "completed" : "running" };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return undefined; }
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
