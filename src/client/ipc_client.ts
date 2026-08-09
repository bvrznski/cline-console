import { promises as fs } from "node:fs";
import path from "node:path";
import { ClineConsoleError } from "../common/errors";
import { makeRequest } from "../ipc/protocol";
import { requestOverSocket } from "../ipc/transport";
import type { Action, IpcRequest, WorkspaceRegistration } from "../ipc/types";
import { runtimeDirectory } from "../extension/workspace_registry";

export async function loadRegistrations(directory = runtimeDirectory()): Promise<WorkspaceRegistration[]> {
  let names: string[];
  try { names = await fs.readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const registrations: WorkspaceRegistration[] = [];
  for (const name of names.filter(value => value.endsWith(".json"))) {
    try {
      const value = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as WorkspaceRegistration;
      if (value.protocolVersion === 1 && typeof value.workspace === "string" && typeof value.socketPath === "string") {
        if (!processExists(value.pid)) { await fs.unlink(path.join(directory, name)).catch(() => undefined); continue; }
        registrations.push(value);
      }
    } catch { /* Ignore incomplete or unrelated registry files. */ }
  }
  return registrations;
}

function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function resolveWorkspace(registrations: WorkspaceRegistration[], explicit: string | undefined, cwd: string): Promise<WorkspaceRegistration> {
  if (!registrations.length) throw new ClineConsoleError("NO_WORKSPACES", "No running VS Code workspaces with Cline Console are registered.");
  if (explicit) {
    const wanted = await fs.realpath(path.resolve(explicit));
    const match = await findByRealPath(registrations, wanted);
    if (!match) throw new ClineConsoleError("WORKSPACE_NOT_REGISTERED", `No registered VS Code workspace matches ${wanted}.`);
    return match;
  }
  const realCwd = await fs.realpath(cwd);
  const parents: Array<{ registration: WorkspaceRegistration; real: string }> = [];
  for (const registration of registrations) {
    try {
      const real = await fs.realpath(registration.workspace);
      if (realCwd === real || realCwd.startsWith(`${real}${path.sep}`)) parents.push({ registration, real });
    } catch { /* Workspace disappeared. */ }
  }
  parents.sort((a, b) => b.real.length - a.real.length);
  if (parents.length) return parents[0].registration;
  if (registrations.length === 1) return registrations[0];
  throw new ClineConsoleError("AMBIGUOUS_WORKSPACE", "Multiple VS Code workspaces are registered. Use --workspace /path/to/repo.");
}

export function parseWorkspaceSelection(registrations: WorkspaceRegistration[], input: string): WorkspaceRegistration | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= registrations.length) return registrations[numeric - 1];
  return registrations.find(registration => registration.id === trimmed || registration.workspace === trimmed);
}

async function findByRealPath(registrations: WorkspaceRegistration[], wanted: string): Promise<WorkspaceRegistration | undefined> {
  for (const registration of registrations) {
    try { if (await fs.realpath(registration.workspace) === wanted) return registration; } catch { /* ignore */ }
  }
  return undefined;
}

export async function invoke(registration: WorkspaceRegistration, action: Action, payload?: IpcRequest["payload"]): Promise<unknown> {
  const serviceSocket = path.join(runtimeDirectory(), "service.sock");
  const response = await requestOverSocket(serviceSocket, makeRequest(action, registration.workspace, payload));
  if (!response.ok) throw new ClineConsoleError(response.error?.code ?? "REMOTE_ERROR", response.error?.message ?? "Unknown VS Code extension error.");
  return response.result;
}
