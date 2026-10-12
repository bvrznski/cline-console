import type { QueueItem, PersistentQueueState } from "./task_queue";
import { execSync } from "node:child_process";
import path from "node:path";

export interface TaskSupervisionOptions {
  /** Maximum duration a task can run before being flagged (ms) */
  maxTaskDurationMs: number;
  /** Maximum time an interrupted task can remain unprocessed (ms) */
  maxInterruptedDurationMs: number;
  /** Enable automatic timeout handling for stuck tasks */
  enableTimeoutHandling: boolean;
  /** Log warnings when tasks approach duration limits */
  logWarnings: boolean;
}

export const DEFAULT_TASK_SUPERVISION_OPTIONS: TaskSupervisionOptions = {
  maxTaskDurationMs: 2 * 60 * 60 * 1000, // 2 hours
  maxInterruptedDurationMs: 5 * 60 * 1000, // 5 minutes
  enableTimeoutHandling: true,
  logWarnings: true
};

export interface TaskSupervisionResult {
  /** Tasks that have exceeded their duration limits */
  timedOutTasks: QueueItem[];
  /** Tasks approaching duration limits (80% threshold) */
  warningTasks: QueueItem[];
  /** Summary of supervision findings */
  summary: string;
}

/**
 * Check all tasks for potential issues based on timing and state
 */
export function checkTaskSupervision(
  items: QueueItem[],
  options: TaskSupervisionOptions = DEFAULT_TASK_SUPERVISION_OPTIONS
): TaskSupervisionResult {
  const now = Date.now();
  const timedOutTasks: QueueItem[] = [];
  const warningTasks: QueueItem[] = [];

  for (const item of items) {
    // Check running tasks for excessive duration
    if (item.state === "running" && item.dispatchedAt) {
      const dispatchTime = Date.parse(item.dispatchedAt);
      const durationMs = now - dispatchTime;

      if (durationMs > options.maxTaskDurationMs) {
        timedOutTasks.push(item);
      } else if (durationMs > options.maxTaskDurationMs * 0.8 && options.logWarnings) {
        warningTasks.push(item);
      }
    }

    // Check for interrupted tasks with stale status
    if (item.error?.includes("stale") || item.error?.includes("disappeared")) {
      const checkTime = item.finishedAt ? Date.parse(item.finishedAt) :
                        item.dispatchedAt ? Date.parse(item.dispatchedAt) :
                        item.queuedAt ? Date.parse(item.queuedAt) : now;
      const durationMs = now - checkTime;

      if (durationMs > options.maxInterruptedDurationMs) {
        timedOutTasks.push(item);
      }
    }

    // Check for tasks with no progress markers
    if (!item.dispatchedAt && item.state === "queued" && item.queuedAt) {
      const queuedTime = Date.parse(item.queuedAt);
      const durationMs = now - queuedTime;

      // Flag tasks that have been queued for more than 1 hour without being dispatched
      if (durationMs > 60 * 60 * 1000 && options.logWarnings) {
        warningTasks.push(item);
      }
    }
  }

  const summary = buildSupervisionSummary(timedOutTasks, warningTasks, items, now);

  return { timedOutTasks, warningTasks, summary };
}

/**
 * Build a human-readable summary of supervision findings
 */
export function buildSupervisionSummary(
  timedOutTasks: QueueItem[],
  warningTasks: QueueItem[],
  allItems: QueueItem[],
  now: number = Date.now()
): string {
  const lines: string[] = [];

  const totalTasks = allItems.length;
  const queued = allItems.filter(i => i.state === "queued").length;
  const running = allItems.filter(i => i.state === "running").length;
  const completed = allItems.filter(i => i.state === "completed").length;
  const failed = allItems.filter(i => i.state === "failed").length;
  const interrupted = allItems.filter(i => i.error?.includes("stale") || i.error?.includes("disappeared")).length;

  lines.push(`Task Supervision Report (${new Date(now).toISOString()}):`);
  lines.push(`  Total Tasks: ${totalTasks}`);
  lines.push(`  Queued: ${queued}, Running: ${running}, Completed: ${completed}, Failed: ${failed}, Interrupted/Stale: ${interrupted}`);

  if (timedOutTasks.length > 0) {
    lines.push("");
    lines.push(`⚠️  TIMEOUT ISSUES (${timedOutTasks.length}):`);
    for (const item of timedOutTasks) {
      const dispatchTime = item.dispatchedAt ? Date.parse(item.dispatchedAt) :
                           item.queuedAt ? Date.parse(item.queuedAt) : now;
      const durationMs = now - dispatchTime;
      lines.push(`  - ${item.id}: "${taskTitleFromItem(item)}"`);
      lines.push(`    State: ${item.state}, Duration: ${(durationMs / 1000).toFixed(1)}s`);
      if (item.error) {
        lines.push(`    Error: ${item.error.substring(0, 100)}${item.error.length > 100 ? "..." : ""}`);
      }
    }
  }

  if (warningTasks.length > 0) {
    lines.push("");
    lines.push(`⚠️  WARNING ISSUES (${warningTasks.length}):`);
    for (const item of warningTasks) {
      const dispatchTime = item.dispatchedAt ? Date.parse(item.dispatchedAt) :
                           item.queuedAt ? Date.parse(item.queuedAt) : now;
      const durationMs = now - dispatchTime;
      lines.push(`  - ${item.id}: "${taskTitleFromItem(item)}"`);
      lines.push(`    State: ${item.state}, Duration: ${(durationMs / 1000).toFixed(1)}s`);
    }
  }

  if (timedOutTasks.length === 0 && warningTasks.length === 0) {
    lines.push("");
    lines.push("✓ All tasks within acceptable duration limits");
  }

  return lines.join("\n");
}

/**
 * Extract task title from QueueItem
 */
function taskTitleFromItem(item: QueueItem): string {
  // Try to extract title using the existing taskTitle function
  const title = item.prompt ? item.prompt.split('\n')[0].substring(0, 50) : "(no prompt)";
  return title;
}

/**
 * Get a task's current status based on supervision rules
 */
export function getTaskSupervisionStatus(
  item: QueueItem,
  options: TaskSupervisionOptions = DEFAULT_TASK_SUPERVISION_OPTIONS
): "healthy" | "warning" | "timeout" {
  const now = Date.now();

  if (item.state === "running" && item.dispatchedAt) {
    const dispatchTime = Date.parse(item.dispatchedAt);
    const durationMs = now - dispatchTime;

    if (durationMs > options.maxTaskDurationMs) return "timeout";
    if (durationMs > options.maxTaskDurationMs * 0.8) return "warning";
  }

  // Check for stale/interrupted tasks
  if (item.error?.includes("stale") || item.error?.includes("disappeared")) {
    const checkTime = item.finishedAt ? Date.parse(item.finishedAt) :
                      item.dispatchedAt ? Date.parse(item.dispatchedAt) :
                      item.queuedAt ? Date.parse(item.queuedAt) : now;
    const durationMs = now - checkTime;

    if (durationMs > options.maxInterruptedDurationMs) return "timeout";
  }

  // Check for queued tasks that haven't been dispatched
  if (!item.dispatchedAt && item.state === "queued" && item.queuedAt) {
    const queuedTime = Date.parse(item.queuedAt);
    const durationMs = now - queuedTime;

    if (durationMs > 60 * 60 * 1000) return "warning";
  }

  return "healthy";
}

/**
 * Format supervision status for display
 */
export function formatSupervisionStatus(
  item: QueueItem,
  options: TaskSupervisionOptions = DEFAULT_TASK_SUPERVISION_OPTIONS
): string {
  const status = getTaskSupervisionStatus(item, options);

  if (status === "timeout") return "⚠️ TIMEOUT";
  if (status === "warning") return "⚠️ WARNING";
  return "✓ OK";
}

/**
 * Generate a task supervision report for all items
 */
export function generateSupervisionReport(
  items: QueueItem[],
  options: TaskSupervisionOptions = DEFAULT_TASK_SUPERVISION_OPTIONS
): string {
  const result = checkTaskSupervision(items, options);

  return [
    "═══════════════════════════════════════════════════════════",
    "           TASK SUPERVISION REPORT",
    "═══════════════════════════════════════════════════════════",
    "",
    result.summary,
    "",
    "═══════════════════════════════════════════════════════════",
    options.enableTimeoutHandling && result.timedOutTasks.length > 0
      ? "⚠️  ACTION REQUIRED: Review and handle timed-out tasks"
      : "",
    "═══════════════════════════════════════════════════════════"
  ].filter(line => line.length > 0).join("\n");
}

/**
 * Check if git is available and the workspace is a git repository
 */
export function isGitRepository(workspacePath: string): boolean {
  try {
    execSync(`cd ${JSON.stringify(workspacePath)} && git rev-parse --git-dir`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get current git status
 */
export function getGitStatus(workspacePath: string): string {
  try {
    const status = execSync(`cd ${JSON.stringify(workspacePath)} && git status --short`, { encoding: "utf8", stdio: "pipe" });
    return status.trim();
  } catch (error) {
    return `git status unavailable: ${(error as Error).message}`;
  }
}

/**
 * Get list of changed files in git
 */
export function getChangedFiles(workspacePath: string): string[] {
  try {
    const output = execSync(`cd ${JSON.stringify(workspacePath)} && git diff --name-only HEAD`, { encoding: "utf8", stdio: "pipe" });
    return output.trim().split("\n").filter(line => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Get staged files in git
 */
export function getStagedFiles(workspacePath: string): string[] {
  try {
    const output = execSync(`cd ${JSON.stringify(workspacePath)} && git diff --name-only --cached`, { encoding: "utf8", stdio: "pipe" });
    return output.trim().split("\n").filter(line => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Check if there are uncommitted changes
 */
export function hasUncommittedChanges(workspacePath: string): boolean {
  try {
    const status = execSync(`cd ${JSON.stringify(workspacePath)} && git status --porcelain`, { encoding: "utf8", stdio: "pipe" });
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the last commit message
 */
export function getLastCommitMessage(workspacePath: string): string | undefined {
  try {
    const output = execSync(`cd ${JSON.stringify(workspacePath)} && git log -1 --pretty=%B`, { encoding: "utf8", stdio: "pipe" });
    return output.trim();
  } catch {
    return undefined;
  }
}

/**
 * Generate a commit message based on task completion
 */
export function generateCommitMessage(taskPrompt: string, changedFiles: string[]): string {
  const summary = taskPrompt.split("\n")[0].substring(0, 50);
  const fileCount = changedFiles.length;

  let message = `chore: ${summary}\n\n`;
  message += `Task completed: ${taskPrompt.substring(0, 200)}...\n\n`;
  message += `Changed files (${fileCount}):\n${changedFiles.map(f => `- ${f}`).join("\n")}`;

  return message;
}

/**
 * Commit all changes with a generated message
 */
export function commitChanges(workspacePath: string, message: string): boolean {
  try {
    execSync(`cd ${JSON.stringify(workspacePath)} && git add -A`, { stdio: "pipe" });
    execSync(`cd ${JSON.stringify(workspacePath)} && git commit -m ${JSON.stringify(message)}`, { stdio: "pipe" });
    return true;
  } catch (error) {
    console.error(`Git commit failed: ${(error as Error).message}`);
    return false;
  }
}

/**
 * Enforce git commit after task completion
 */
export function enforceGitCommit(
  workspacePath: string,
  taskPrompt: string,
  options?: { force?: boolean; messagePrefix?: string }
): { committed: boolean; message?: string; error?: string } {
  if (!isGitRepository(workspacePath)) {
    return { committed: false, error: "Not a git repository" };
  }

  const changedFiles = getChangedFiles(workspacePath);

  // If no changes or all changes are already staged, nothing to commit
  if (changedFiles.length === 0) {
    return { committed: true, message: "No uncommitted changes" };
  }

  // Generate commit message
  let commitMessage = generateCommitMessage(taskPrompt, changedFiles);
  if (options?.messagePrefix) {
    commitMessage = `${options.messagePrefix}\n\n${commitMessage}`;
  }

  // Commit the changes
  const success = commitChanges(workspacePath, commitMessage);

  return {
    committed: success,
    message: success ? `Committed ${changedFiles.length} file(s)` : undefined,
    error: success ? undefined : "Failed to commit changes"
  };
}
