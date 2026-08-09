import type { QueueStatus } from "../../ipc/types";

export interface WorkspaceQueueStatus { workspace: string; status?: QueueStatus; error?: string; }

export function formatQueues(items: WorkspaceQueueStatus[]): string {
  if (!items.length) return "No registered VS Code workspaces.";
  return items.map(item => item.error
    ? `Workspace: ${item.workspace}\nQueue unavailable: ${item.error}`
    : formatQueue(item.status!)).join("\n\n");
}

export function formatQueue(status: QueueStatus): string {
  const lines = [
    `Workspace: ${status.workspace}`,
    `Queue length: ${status.queueLength} (${status.running} running, ${status.queued} queued)`,
    `History retained: ${status.completed} completed, ${status.failed} failed`
  ];
  if (!status.items.length) return [...lines, "", "Queue is empty."].join("\n");
  const positionWidth = Math.max("Pos".length, ...status.items.map(item => String(item.position).length));
  const typeWidth = Math.max("Type".length, ...status.items.map(item => item.kind.length));
  const stateWidth = Math.max("State".length, ...status.items.map(item => item.state.length));
  lines.push("", `${"Pos".padEnd(positionWidth)}  ${"Type".padEnd(typeWidth)}  ${"State".padEnd(stateWidth)}  Title  Source`);
  for (const item of status.items) {
    lines.push(`${String(item.position).padEnd(positionWidth)}  ${item.kind.padEnd(typeWidth)}  ${item.state.padEnd(stateWidth)}  ${item.title}  ${item.sourcePath}`);
  }
  return lines.join("\n");
}
