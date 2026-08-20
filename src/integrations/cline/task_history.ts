import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { hasExplicitRemainingWork } from "./remaining_work";

export interface DeletedTaskHistory { deleted: number; taskIds: string[]; }
export interface UnfinishedTaskHistory { sessionId: string; prompt: string; sourcePath: string; }

export async function getLegacyUnfinishedWorkspaceTasks(workspace: string, vscodeStorageOverride?: string): Promise<UnfinishedTaskHistory[]> {
  const storage = vscodeStorageOverride || process.env.CLINE_VSCODE_STORAGE_DIR?.trim() || path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  let history: Array<Record<string, unknown>>;
  try { history = JSON.parse(await fs.readFile(path.join(storage, "state", "taskHistory.json"), "utf8")) as Array<Record<string, unknown>>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (!Array.isArray(history)) throw new Error("Cline task history is not an array.");
  const unfinished: UnfinishedTaskHistory[] = [];
  for (const entry of history) {
    if (entry.cwdOnTaskInitialization !== workspace || typeof entry.id !== "string" || typeof entry.task !== "string" || !entry.task.length) continue;
    try {
      const messages = JSON.parse(await fs.readFile(path.join(storage, "tasks", entry.id, "ui_messages.json"), "utf8")) as Array<Record<string, unknown>>;
      const completionText = [...messages].reverse().find(message =>
        (message.ask === "completion_result" || message.say === "completion_result") && typeof message.text === "string"
      )?.text;
      const taskProgressText = [...messages].reverse().find(message =>
        (message.ask === "task_progress" || message.say === "task_progress") && typeof message.text === "string"
      )?.text;
      if (hasExplicitRemainingWork(typeof completionText === "string" ? completionText : undefined, typeof taskProgressText === "string" ? taskProgressText : undefined)) {
        unfinished.push({ sessionId: entry.id, prompt: entry.task, sourcePath: `cline-history:${entry.id}` });
      }
    } catch { /* Missing or transient task data is not safe to classify as unfinished. */ }
  }
  return unfinished;
}

export async function deleteLegacyQueuedTaskHistory(workspace: string, prompts: string[], knownTaskIds: string[], vscodeStorageOverride?: string): Promise<DeletedTaskHistory> {
  return deleteLegacyTaskHistory(workspace, entry => knownTaskIds.includes(String(entry.id)) || (typeof entry.task === "string" && prompts.includes(entry.task)), vscodeStorageOverride);
}

export async function deleteLegacyWorkspaceTaskHistory(workspace: string, vscodeStorageOverride?: string): Promise<DeletedTaskHistory> {
  return deleteLegacyTaskHistory(workspace, () => true, vscodeStorageOverride);
}

async function deleteLegacyTaskHistory(workspace: string, matches: (entry: Record<string, unknown>) => boolean, vscodeStorageOverride?: string): Promise<DeletedTaskHistory> {
  const storage = vscodeStorageOverride || process.env.CLINE_VSCODE_STORAGE_DIR?.trim() || path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  const historyFile = path.join(storage, "state", "taskHistory.json");
  let history: Array<Record<string, unknown>>;
  try { history = JSON.parse(await fs.readFile(historyFile, "utf8")) as Array<Record<string, unknown>>; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { deleted: 0, taskIds: [] };
    throw error;
  }
  if (!Array.isArray(history)) throw new Error("Cline task history is not an array.");
  const removed = history.filter(entry => entry.cwdOnTaskInitialization === workspace && typeof entry.id === "string" && matches(entry));
  if (!removed.length) return { deleted: 0, taskIds: [] };
  const removedIds = new Set(removed.map(entry => String(entry.id)));
  const retained = history.filter(entry => !removedIds.has(String(entry.id)));
  const temporary = `${historyFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(retained), { mode: 0o600 });
  await fs.rename(temporary, historyFile);
  await Promise.all([...removedIds].map(id => fs.rm(path.join(storage, "tasks", id), { recursive: true, force: true })));
  return { deleted: removedIds.size, taskIds: [...removedIds] };
}
