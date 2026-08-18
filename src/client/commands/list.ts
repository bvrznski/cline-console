import type { WorkspaceRegistration } from "../../ipc/types";
import { bold, color, supportsColor } from "../../common/terminal";

export function formatWorkspaces(registrations: WorkspaceRegistration[], colors = supportsColor()): string {
  if (!registrations.length) return "No registered VS Code workspaces.";
  const idWidth = Math.max(2, ...registrations.map(item => item.id.length));
  return [ bold(`${"ID".padEnd(idWidth)}  Workspace`, colors), ...registrations.map(item => `${color(item.id.padEnd(idWidth), "gray", colors)}  ${color(item.workspace, "cyan", colors)}`) ].join("\n");
}
