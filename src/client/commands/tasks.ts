import type { ClineStatus } from "../../integrations/cline/types";
import { bold, color, stateColor, supportsColor } from "../../common/terminal";

export interface WorkspaceTaskStatus {
  workspace: string;
  status?: ClineStatus;
  error?: string;
}

export function formatTasks(items: WorkspaceTaskStatus[], colors = supportsColor()): string {
  if (!items.length) return "No registered VS Code workspaces.";
  const workspaceWidth = Math.max("Workspace".length, ...items.map(item => item.workspace.length));
  const titleWidth = Math.max("Title".length, ...items.map(item => item.status?.title?.length ?? 1));
  const lines = [bold(`${"Workspace".padEnd(workspaceWidth)}  Task     State       Cline  ${"Title".padEnd(titleWidth)}  Source`, colors)];
  for (const item of items) {
    if (item.error) {
      lines.push(`${color(item.workspace.padEnd(workspaceWidth), "cyan", colors)}  ${color("error   ", "red", colors)} ${color("unavailable", "red", colors)}  unknown  ${"-".padEnd(titleWidth)}  ${item.error}`);
      continue;
    }
    const status = item.status!;
    lines.push(`${color(item.workspace.padEnd(workspaceWidth), "cyan", colors)}  ${color(status.task.padEnd(8), stateColor(status.task), colors)} ${color(status.state.padEnd(11), stateColor(status.state), colors)} ${status.version ?? "unknown"}  ${(status.title ?? "-").padEnd(titleWidth)}  ${color(status.sourcePath ?? "-", "gray", colors)}`);
  }
  lines.push("", "Task state is reconciled from Cline's latest per-workspace session metadata.");
  return lines.join("\n");
}
