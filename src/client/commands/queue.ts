import type { QueueStatus } from "../../ipc/types";
import { bold, color, stateColor, supportsColor } from "../../common/terminal";
import { formatTokenCount } from "../../common/token_count";

export interface WorkspaceQueueStatus { workspace: string; status?: QueueStatus; error?: string; companionConnected?: boolean; }

export function formatQueues(items: WorkspaceQueueStatus[], colors = supportsColor()): string {
  if (!items.length) return "No registered VS Code workspaces.";
  return items.map(item => item.error
    ? `${bold("Workspace:", colors)} ${color(item.workspace, "cyan", colors)}\n${color("Queue unavailable:", "red", colors)} ${item.error}`
    : formatQueue(item.status!, colors, item.companionConnected)).join("\n\n");
}

export function formatQueue(status: QueueStatus, colors = supportsColor(), companionConnected?: boolean): string {
  const interrupted = status.interrupted ?? status.items.filter(item => item.state === "interrupted").length;
  const waiting = status.items.some(item => item.state === "waiting");
  const processing = status.paused ? "paused" : interrupted ? "interrupted" : status.running ? "running" : waiting ? "waiting" : status.items.some(item => item.state === "closed") ? "closed" : "idle";
  const lines = [
    `${bold("Workspace:", colors)} ${color(status.workspace, "cyan", colors)}`,
    ...(companionConnected === undefined ? [] : [`${bold("VS Code companion:", colors)} ${color(companionConnected ? "connected" : "offline", companionConnected ? "green" : "yellow", colors)}`]),
    `${bold("Processing:", colors)} ${color(processing, status.paused ? "yellow" : interrupted ? "magenta" : processing === "waiting" ? "yellow" : processing === "idle" ? "gray" : "green", colors)}`,
    `${bold("Queue length:", colors)} ${status.queueLength} (${color(String(status.running), "yellow", colors)} running, ${color(String(interrupted), "magenta", colors)} interrupted, ${color(String(status.queued), "cyan", colors)} queued)`,
    `${bold("History retained:", colors)} ${color(String(status.completed), "green", colors)} completed, ${color(String(status.failed), status.failed ? "red" : "gray", colors)} failed, ${color(String(status.skipped ?? 0), "yellow", colors)} skipped`,
    `${bold("Managed tokens:", colors)} ${color(formatTokenCount(status.tokenUsage?.total), "magenta", colors)} total (${formatTokenCount(status.tokenUsage?.input)} in, ${formatTokenCount(status.tokenUsage?.output)} out; ${status.tokenUsage?.sessions ?? 0} session(s))`
  ];
  if (!status.items.length) return [...lines, "", color("Queue is empty.", "gray", colors)].join("\n");
  const current = status.items.find(item => item.state === "running" || item.state === "waiting" || item.state === "interrupted");
  if (current?.yoloRestartCount) lines.push(`${bold("YOLO recovery:", colors)} ${color(`${current.yoloRestartCount} restart(s) requested; last ${current.lastYoloRestartAt ?? "unknown"}`, "yellow", colors)}`);
  const positionWidth = Math.max("Pos".length, ...status.items.map(item => item.position === undefined ? 1 : String(item.position).length));
  const typeWidth = Math.max("Type".length, ...status.items.map(item => item.kind.length));
  const stateWidth = Math.max("State".length, ...status.items.map(item => item.state.length));
  const tokenWidth = Math.max("Tokens".length, ...status.items.map(item => formatTokenCount(item.tokenUsage?.total).length));
  const titleWidth = Math.max("Title".length, ...status.items.map(item => item.title.length));
  const header = `${"Pos".padEnd(positionWidth)}  ${"Type".padEnd(typeWidth)}  ${"State".padEnd(stateWidth)}  ${"Tokens".padStart(tokenWidth)}  ${"Title".padEnd(titleWidth)}  Source`;
  const separator = `${"-".repeat(positionWidth)}  ${"-".repeat(typeWidth)}  ${"-".repeat(stateWidth)}  ${"-".repeat(tokenWidth)}  ${"-".repeat(titleWidth)}  ${"-".repeat("Source".length)}`;
  lines.push("", bold(header, colors), color(separator, "gray", colors));
  for (const item of status.items) {
    const position = (item.position === undefined ? "-" : String(item.position)).padEnd(positionWidth), kind = item.kind.padEnd(typeWidth), state = item.state.padEnd(stateWidth), title = item.title.padEnd(titleWidth);
    const tokens = formatTokenCount(item.tokenUsage?.total).padStart(tokenWidth);
    lines.push(`${position}  ${kind}  ${color(state, stateColor(item.state), colors)}  ${color(tokens, "magenta", colors)}  ${title}  ${color(item.sourcePath, "gray", colors)}`);
  }
  return lines.join("\n");
}
