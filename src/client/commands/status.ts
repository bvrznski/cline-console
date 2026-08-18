import type { ClineStatus } from "../../integrations/cline/types";
import { bold, color, stateColor, supportsColor } from "../../common/terminal";

export function formatStatus(workspace: string, status: ClineStatus, colors = supportsColor()): string {
  return [
    `${bold("Workspace:", colors)} ${color(workspace, "cyan", colors)}`,
    `${bold("Cline:", colors)} ${color(status.connected ? "connected" : "unavailable", status.connected ? "green" : "red", colors)}`,
    `${bold("Version:", colors)} ${status.version ?? "unknown"}`,
    `${bold("Task:", colors)} ${color(status.task, stateColor(status.task), colors)}`,
    `${bold("State:", colors)} ${color(status.state, stateColor(status.state), colors)}`,
    ...(status.detail ? [`Detail: ${status.detail}`] : [])
  ].join("\n");
}
