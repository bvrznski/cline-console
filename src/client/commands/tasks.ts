import type { ClineStatus } from "../../integrations/cline/types";

export interface WorkspaceTaskStatus {
  workspace: string;
  status?: ClineStatus;
  error?: string;
}

export function formatTasks(items: WorkspaceTaskStatus[]): string {
  if (!items.length) return "No registered VS Code workspaces.";
  const workspaceWidth = Math.max("Workspace".length, ...items.map(item => item.workspace.length));
  const lines = [`${"Workspace".padEnd(workspaceWidth)}  Task     State       Cline  Title`];
  for (const item of items) {
    if (item.error) {
      lines.push(`${item.workspace.padEnd(workspaceWidth)}  error    unavailable  unknown  ${item.error}`);
      continue;
    }
    const status = item.status!;
    lines.push(`${item.workspace.padEnd(workspaceWidth)}  ${status.task.padEnd(8)} ${status.state.padEnd(11)} ${status.version ?? "unknown"}  ${status.title ?? "-"}`);
  }
  lines.push("", "Task state is reconciled from Cline's latest per-workspace session metadata.");
  return lines.join("\n");
}
