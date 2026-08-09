import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkspaceRegistration } from "../ipc/types";

export function runtimeDirectory(configured = ""): string {
  if (configured) return path.resolve(configured);
  const xdg = process.env.XDG_RUNTIME_DIR;
  return xdg ? path.join(xdg, "cline-console") : path.join(os.homedir(), ".cache", "cline-console");
}

export function workspaceId(workspace: string): string {
  return createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 16);
}

export async function ensureRuntimeDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

export function registrationPath(directory: string, id: string): string { return path.join(directory, `${id}.json`); }
export function socketPath(directory: string, id: string): string { return path.join(directory, `${id}.sock`); }

export async function registerWorkspace(directory: string, workspace: string): Promise<WorkspaceRegistration> {
  await ensureRuntimeDirectory(directory);
  const resolved = await fs.realpath(workspace);
  const id = workspaceId(resolved);
  const registration: WorkspaceRegistration = { protocolVersion: 1, id, workspace: resolved, socketPath: socketPath(directory, id), pid: process.pid, registeredAt: new Date().toISOString() };
  const target = registrationPath(directory, id), temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(registration, null, 2), { mode: 0o600 });
  await fs.rename(temporary, target);
  return registration;
}

export async function unregisterWorkspace(directory: string, registration: WorkspaceRegistration): Promise<void> {
  await Promise.allSettled([fs.unlink(registrationPath(directory, registration.id)), fs.unlink(registration.socketPath)]);
}
