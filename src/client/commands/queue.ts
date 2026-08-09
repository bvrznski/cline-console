import type { QueueStatus } from "../../ipc/types";

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
