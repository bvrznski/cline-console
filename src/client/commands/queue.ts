import type { QueueStatus } from "../../ipc/types";
import { bold, color, stateColor, supportsColor } from "../../common/terminal";

export interface WorkspaceQueueStatus { workspace: string; status?: QueueStatus; error?: string; companionConnected?: boolean; }

export function formatQueues(items: WorkspaceQueueStatus[], colors = supportsColor()): string {
  if (!items.length) return "No registered VS Code workspaces.";
  return items.map(item => item.error
    ? `${bold("Workspace:", colors)} ${color(item.workspace, "cyan", colors)}\n${color("Queue unavailable:", "red", colors)} ${item.error}`
    : formatQueue(item.status!, colors, item.companionConnected)).join("\n\n");
}

export function formatQueue(status: QueueStatus, colors = supportsColor(), companionConnected?: boolean): string {
  const lines = [
    `${bold("Workspace:", colors)} ${color(status.workspace, "cyan", colors)}`,
    ...(companionConnected === undefined ? [] : [`${bold("VS Code companion:", colors)} ${color(companionConnected ? "connected" : "offline", companionConnected ? "green" : "yellow", colors)}`]),
    `${bold("Processing:", colors)} ${color(status.paused ? "paused" : "running", status.paused ? "yellow" : "green", colors)}`,
    `${bold("Queue length:", colors)} ${status.queueLength} (${color(String(status.running), "yellow", colors)} running, ${color(String(status.queued), "cyan", colors)} queued)`,
    `${bold("History retained:", colors)} ${color(String(status.completed), "green", colors)} completed, ${color(String(status.failed), status.failed ? "red" : "gray", colors)} failed, ${color(String(status.skipped ?? 0), "yellow", colors)} skipped`
  ];
  if (!status.items.length) return [...lines, "", color("Queue is empty.", "gray", colors)].join("\n");
  const positionWidth = Math.max("Pos".length, ...status.items.map(item => String(item.position).length));
  const typeWidth = Math.max("Type".length, ...status.items.map(item => item.kind.length));
  const stateWidth = Math.max("State".length, ...status.items.map(item => item.state.length));
  const titleWidth = Math.max("Title".length, ...status.items.map(item => item.title.length));
  const header = `${"Pos".padEnd(positionWidth)}  ${"Type".padEnd(typeWidth)}  ${"State".padEnd(stateWidth)}  ${"Title".padEnd(titleWidth)}  Source`;
  const separator = `${"-".repeat(positionWidth)}  ${"-".repeat(typeWidth)}  ${"-".repeat(stateWidth)}  ${"-".repeat(titleWidth)}  ${"-".repeat("Source".length)}`;
  lines.push("", bold(header, colors), color(separator, "gray", colors));
  for (const item of status.items) {
    const position = String(item.position).padEnd(positionWidth), kind = item.kind.padEnd(typeWidth), state = item.state.padEnd(stateWidth), title = item.title.padEnd(titleWidth);
    lines.push(`${position}  ${kind}  ${color(state, stateColor(item.state), colors)}  ${title}  ${color(item.sourcePath, "gray", colors)}`);
  }
  return lines.join("\n");
}
