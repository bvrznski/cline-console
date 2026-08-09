import type { ClineStatus } from "../../integrations/cline/types";

export function formatStatus(workspace: string, status: ClineStatus): string {
  return [
    `Workspace: ${workspace}`,
    `Cline: ${status.connected ? "connected" : "unavailable"}`,
    `Version: ${status.version ?? "unknown"}`,
    `Task: ${status.task}`,
    `State: ${status.state}`,
    ...(status.detail ? [`Detail: ${status.detail}`] : [])
  ].join("\n");
}
