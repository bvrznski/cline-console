import type { QueueStatus } from "../../ipc/types";
import { bold, color, stateColor, supportsColor, TerminalColor } from "../../common/terminal";
import { generateSupervisionReport as generateTaskSupervisionReport } from "../../extension/task_supervision";

export interface WorkspaceSupervisionStatus {
  workspace: string;
  status?: QueueStatus;
  error?: string;
}

// Re-export the task supervision functions for CLI use
export { generateSupervisionReport, type TaskSupervisionOptions } from "../../extension/task_supervision";

export function formatSupervision(items: WorkspaceSupervisionStatus[], colors = supportsColor()): string {
  if (!items.length) return "No registered VS Code workspaces.";

  const lines: string[] = [];

  for (const item of items) {
    if (item.error) {
      lines.push(`${bold("Workspace:", colors)} ${color(item.workspace, "cyan", true)}`);
      lines.push(`${color("Error:", "red" as TerminalColor, true)} ${color(item.error, "red", true)}`);
      continue;
    }

    const status = item.status!;
    const totalTasks = status.items.length;
    const running = status.running;
    const queued = status.queued;
    const completed = status.completed;
    const failed = status.failed;

    lines.push(`${bold("Workspace:", colors)} ${color(item.workspace, "cyan", true)}`);
    lines.push(`${bold("Queue Status:", colors)} ${status.paused ? color("paused", "yellow" as TerminalColor, true) : running > 0 ? color("running", "green" as TerminalColor, true) : queued > 0 ? color("active", "cyan" as TerminalColor, true) : color("idle", "gray" as TerminalColor, true)}`);
    lines.push(`${bold("Tasks:", colors)} Total: ${totalTasks}, Running: ${color(String(running), "yellow" as TerminalColor, true)}, Queued: ${color(String(queued), "cyan" as TerminalColor, true)}, Completed: ${color(String(completed), "green" as TerminalColor, true)}, Failed: ${color(String(failed), failed > 0 ? ("red" as TerminalColor) : ("gray" as TerminalColor), true)}`);

    if (status.items.length > 0) {
      lines.push("");
      const positionWidth = Math.max("Pos".length, ...status.items.map(item => item.position === undefined ? 1 : String(item.position).length));
      const typeWidth = Math.max("Type".length, ...status.items.map(item => item.kind.length));
      const stateWidth = Math.max("State".length, ...status.items.map(item => item.state.length));
      const titleWidth = Math.max("Title".length, ...status.items.map(item => item.title.length));

      lines.push(`${"Pos".padEnd(positionWidth)}  ${"Type".padEnd(typeWidth)}  ${"State".padEnd(stateWidth)}  ${"Supervision".padEnd(10)}  ${"Title".padEnd(titleWidth)}`);
      lines.push(`${"-".repeat(positionWidth)}  ${"-".repeat(typeWidth)}  ${"-".repeat(stateWidth)}  ${"-".repeat(10)}  ${"-".repeat(titleWidth)}`);

      for (const task of status.items) {
        const position = (task.position === undefined ? "-" : String(task.position)).padEnd(positionWidth);
        const kind = task.kind.padEnd(typeWidth);
        const state = task.state.padEnd(stateWidth);

        // Determine supervision status
        let supervisionStatus = "OK";
        if (task.state === "running" && task.dispatchedAt) {
          const dispatchTime = Date.parse(task.dispatchedAt);
          const durationMs = Date.now() - dispatchTime;
          if (durationMs > 2 * 60 * 60 * 1000) { // 2 hours
            supervisionStatus = "TIMEOUT";
          } else if (durationMs > 90 * 60 * 1000) { // 90 minutes
            supervisionStatus = "WARNING";
          }
        }

        lines.push(`${position}  ${kind}  ${color(state, stateColor(task.state), colors)}  ${color(supervisionStatus.padEnd(10), supervisionStatus === "TIMEOUT" ? "red" : supervisionStatus === "WARNING" ? "yellow" : "green", colors)}  ${task.title}`);
      }
    }

    lines.push("");
  }

  return lines.join("\n");
}

export function formatSupervisionReport(workspace: string, report: string, colors = supportsColor()): string {
  const lines = [
    `${bold("═══════════════════════════════════════════════════════════", colors)}`,
    `${color("           TASK SUPERVISION REPORT", "cyan", colors)}`,
    `${bold("═══════════════════════════════════════════════════════════", colors)}`
  ];

  for (const line of report.split("\n")) {
    if (line.includes("TIMEOUT ISSUES") || line.includes("WARNING ISSUES")) {
      lines.push(color(line, "yellow", colors));
    } else if (line.includes("✓ All tasks within acceptable duration limits")) {
      lines.push(color(line, "green", colors));
    } else if (line.startsWith("  -")) {
      lines.push(color(line, "gray", colors));
    } else if (line.includes("ACTION REQUIRED")) {
      lines.push(color(line, "red", colors));
    } else {
      lines.push(line);
    }
  }

  return lines.join("\n");
}