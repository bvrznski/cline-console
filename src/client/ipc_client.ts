import { promises as fs } from "node:fs";
import path from "node:path";
import { ClineConsoleError } from "../common/errors";
import { makeRequest } from "../ipc/protocol";
import { requestOverSocket } from "../ipc/transport";
import type { Action, IpcRequest, WorkspaceRegistration } from "../ipc/types";
import { runtimeDirectory } from "../extension/workspace_registry";

// Import hangup detection functions
import { detectExtensionHangup, restartExtension } from "../extension/hangup_detector";

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

export async function waitForWorkspaceRegistration(explicit: string, cwd: string, directory = runtimeDirectory(), timeoutMs = 3_000, pollIntervalMs = 100): Promise<WorkspaceRegistration> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  do {
    try { return await resolveWorkspace(await loadRegistrations(directory), explicit, cwd); }
    catch (error) {
      if (!(error instanceof ClineConsoleError) || (error.code !== "NO_WORKSPACES" && error.code !== "WORKSPACE_NOT_REGISTERED")) throw error;
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  } while (Date.now() <= deadline);
  throw lastError;
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

/**
 * Maximum number of auto-restart attempts
 */
const MAX_AUTO_RESTART_ATTEMPTS = 1;
const SERVICE_REQUEST_TIMEOUT_MS = 35_000;
const HANGUP_PING_TIMEOUT_MS = 1_500;

export async function invoke(registration: WorkspaceRegistration, action: Action, payload?: IpcRequest["payload"]): Promise<unknown> {
  const serviceSocket = path.join(runtimeDirectory(), "service.sock");

  try {
    // The daemon allows the workspace companion up to 30 seconds to answer.
    // Keep the outer client deadline slightly longer so a slow operation is not
    // misclassified as a hung extension while the daemon is still processing it.
    const response = await requestOverSocket(serviceSocket, makeRequest(action, registration.workspace, payload), SERVICE_REQUEST_TIMEOUT_MS);
    if (!response.ok) throw new ClineConsoleError(response.error?.code ?? "REMOTE_ERROR", response.error?.message ?? "Unknown VS Code extension error.");
    return response.result;
  } catch (error: unknown) {
    // Check if this is a hangup situation
    const isTimeout = error instanceof ClineConsoleError && ((error as ClineConsoleError).code === "TIMEOUT" || (error as ClineConsoleError).code === "RESPONSE_TOO_LARGE" || (error as ClineConsoleError).code === "MALFORMED_RESPONSE");

    // Service-routed recovery commands may intentionally have no live
    // workspace registration yet. Never treat their synthetic target as an
    // extension host PID or attempt to signal the CLI process itself.
    if (registration.socketPath && (isTimeout || (error as Error).message?.includes("Timed out"))) {
      console.error(`Extension appears hung. Attempting to detect and restart...`);

      // Try to ping the extension
      const isHung = await detectExtensionHangup(registration, {
        pingTimeoutMs: HANGUP_PING_TIMEOUT_MS,
        maxConsecutiveFailures: 2
      });

      if (isHung.hung) {
        console.error(`Extension hangup detected: ${isHung.reason}`);

        // Auto-restart the extension
        try {
          await restartExtension(registration);

          // Wait a moment for the extension to restart
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Try the original request again after restart
          const response = await requestOverSocket(serviceSocket, makeRequest(action, registration.workspace, payload), SERVICE_REQUEST_TIMEOUT_MS);
          if (!response.ok) throw new ClineConsoleError(response.error?.code ?? "REMOTE_ERROR", response.error?.message ?? "Unknown VS Code extension error.");
          return response.result;
        } catch (restartError) {
          console.error(`Failed to restart extension: ${(restartError as Error).message}`);
          // Throw original timeout error
          throw new ClineConsoleError("EXTENSION_TIMEOUT", `VS Code extension did not respond after auto-restart attempt`);
        }
      }
    }

    // Re-throw if not a hangup situation or auto-restart failed
    throw error;
  }
}
