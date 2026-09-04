import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const SERVICE_NAME = "cline-console.service";

export function userServiceUnit(executable: string): string {
  return `[Unit]\nDescription=Cline Console local routing service\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${escapeSystemd(executable)} service run\nRestart=on-failure\nRestartSec=2\nTimeoutStopSec=10\nUMask=0077\nStandardOutput=journal\nStandardError=journal\nSyslogIdentifier=cline-console\n\n[Install]\nWantedBy=default.target\n`;
}

export async function installUserService(executable: string): Promise<string> {
  const directory = path.join(os.homedir(), ".config", "systemd", "user");
  const target = path.join(directory, SERVICE_NAME);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(target, userServiceUnit(executable), { mode: 0o644 });
  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
  await execFileAsync("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
  return target;
}

export async function controlUserService(action: "start" | "stop" | "restart"): Promise<void> {
  await execFileAsync("systemctl", ["--user", action, SERVICE_NAME]);
}

function escapeSystemd(value: string): string { return value.replace(/%/g, "%%").replace(/ /g, "\\x20"); }
