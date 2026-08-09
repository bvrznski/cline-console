import type { WorkspaceRegistration } from "../../ipc/types";

export function formatWorkspaces(registrations: WorkspaceRegistration[]): string {
  if (!registrations.length) return "No registered VS Code workspaces.";
  const idWidth = Math.max(2, ...registrations.map(item => item.id.length));
  return [ `${"ID".padEnd(idWidth)}  Workspace`, ...registrations.map(item => `${item.id.padEnd(idWidth)}  ${item.workspace}`) ].join("\n");
}
