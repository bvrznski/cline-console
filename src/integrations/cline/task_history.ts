import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface DeletedTaskHistory { deleted: number; taskIds: string[]; }

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
