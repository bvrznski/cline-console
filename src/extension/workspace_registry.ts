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

export function queueStateDirectory(configured = ""): string {
  if (configured) return path.resolve(configured);
  const xdg = process.env.XDG_STATE_HOME;
  const stateRoot = xdg ? path.resolve(xdg) : path.join(os.homedir(), ".local", "state");
  return path.join(stateRoot, "cline-console", "queues");
}

export function queueStatePath(workspace: string, directory = queueStateDirectory()): string {
  return path.join(directory, `queue-${workspaceId(workspace)}.json`);
}

export async function migrateRuntimeQueueState(runtimeFile: string, persistentFile: string): Promise<boolean> {
  try {
    await fs.access(persistentFile);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let content: string;
  try { content = await fs.readFile(runtimeFile, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  await fs.mkdir(path.dirname(persistentFile), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(persistentFile), 0o700);
  const temporary = `${persistentFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.rename(temporary, persistentFile);
  return true;
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
  if (!await ownsWorkspaceRegistration(directory, registration)) return;
  await Promise.allSettled([fs.unlink(registrationPath(directory, registration.id)), fs.unlink(registration.socketPath)]);
}

export async function ownsWorkspaceRegistration(directory: string, registration: WorkspaceRegistration): Promise<boolean> {
  try {
    const current = JSON.parse(await fs.readFile(registrationPath(directory, registration.id), "utf8")) as Partial<WorkspaceRegistration>;
    return current.protocolVersion === registration.protocolVersion
      && current.id === registration.id
      && current.workspace === registration.workspace
      && current.socketPath === registration.socketPath
      && current.pid === registration.pid
      && current.registeredAt === registration.registeredAt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}
