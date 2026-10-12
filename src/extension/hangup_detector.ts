import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { ClineConsoleError } from "../common/errors";
import { makeRequest } from "../ipc/protocol";
import { requestOverSocket } from "../ipc/transport";
import type { IpcRequest, WorkspaceRegistration } from "../ipc/types";
import { registrationPath, runtimeDirectory, workspaceId } from "./workspace_registry";

/**
 * Configuration for hangup detection
 */
export interface HangupDetectionOptions {
  /** Maximum time to wait for a ping response (ms) */
  pingTimeoutMs: number;
  /** Number of consecutive failed pings before considering hung */
  maxConsecutiveFailures: number;
  /** Time window to consider for detecting hangs (ms) - if all tasks in this window are stuck */
  taskStuckWindowMs: number;
  /** Log detection attempts */
  debug?: boolean;
}

/**
 * Default hangup detection options
 */
export const DEFAULT_HANGUP_DETECTION_OPTIONS: HangupDetectionOptions = {
  pingTimeoutMs: 30_000,
  maxConsecutiveFailures: 3,
  taskStuckWindowMs: 10 * 60 * 1000, // 10 minutes
  debug: false
};

/**
 * Result of hangup detection
 */
export interface HangupDetectionResult {
  /** Whether the extension is hung */
  hung: boolean;
  /** Reason for the hangup detection (if applicable) */
  reason?: string;
  /** Number of consecutive ping failures */
  pingFailures: number;
  /** Duration in ms since last successful ping */
  timeSinceLastSuccess?: number;
}

/**
 * Ping the extension to check if it's responsive
 */
export async function pingExtension(
  registration: WorkspaceRegistration,
  timeoutMs: number = DEFAULT_HANGUP_DETECTION_OPTIONS.pingTimeoutMs
): Promise<boolean> {
  try {
    const request: IpcRequest = makeRequest("ping", registration.workspace);
    await requestOverSocket(registration.socketPath, request, timeoutMs);
    return true;
  } catch (error) {
    if (error instanceof ClineConsoleError && error.code === "TIMEOUT") {
      return false;
    }
    // Any other error also indicates the extension may not be responsive
    return false;
  }
}

/**
 * Detect if the VS Code extension is hung based on ping failures and task states
 */
export async function detectExtensionHangup(
  registration: WorkspaceRegistration,
  options: Partial<HangupDetectionOptions> = {}
): Promise<HangupDetectionResult> {
  const opts = { ...DEFAULT_HANGUP_DETECTION_OPTIONS, ...options };

  // First, try to ping the extension
  const pingSuccess = await pingExtension(registration, opts.pingTimeoutMs);
  if (pingSuccess) {
    return { hung: false, pingFailures: 0 };
  }

  let consecutiveFailures = 1;

  // If first ping fails, try a few more times to confirm
  while (consecutiveFailures < opts.maxConsecutiveFailures) {
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait between retries
    if (!await pingExtension(registration, opts.pingTimeoutMs)) {
      consecutiveFailures++;
    } else {
      break; // Ping succeeded, extension is not hung
    }
  }

  if (consecutiveFailures >= opts.maxConsecutiveFailures) {
    return {
      hung: true,
      reason: `Extension did not respond to ${consecutiveFailures} consecutive ping attempts`,
      pingFailures: consecutiveFailures
    };
  }

  // A recovered ping proves that the event loop is responsive. Queue age is
  // not a liveness signal: legitimate tasks and batches can run for hours.
  // Semantic stall detection belongs to the scanner, which has progress and
  // completion evidence, not to this transport watchdog.
  return { hung: false, pingFailures: consecutiveFailures };
}

/**
 * Restart the VS Code extension for a workspace by killing and restarting it
 */
export async function restartExtension(registration: WorkspaceRegistration): Promise<WorkspaceRegistration> {
  const pid = registration.pid;

  if (!processExists(pid)) {
    throw new ClineConsoleError("EXTENSION_NOT_RUNNING", `Extension process ${pid} is not running`);
  }

  // Send SIGTERM to gracefully stop the extension
  try {
    process.kill(pid, "SIGTERM");

    // Wait for process to exit
    await waitForProcessExit(pid, 3000);

    // If still running, force kill with SIGKILL
    if (processExists(pid)) {
      process.kill(pid, "SIGKILL");
      await waitForProcessExit(pid, 2000);

      if (!processExists(pid)) {
        console.error(`Extension process ${pid} was force-killed`);
      }
    }
  } catch (error) {
    throw new ClineConsoleError("EXTENSION_RESTART_FAILED", `Failed to restart extension: ${(error as Error).message}`);
  }

  // Restart the VS Code window with the extension
  const codeCommand = process.env.CLINE_CONSOLE_CODE_COMMAND?.trim() || "code";

  try {
    const { spawn } = await import("node:child_process");
    // --reuse-window may target whichever VS Code window was most recently
    // active, which can move Cline recovery into the wrong workspace.  An
    // explicit new window gives the requested workspace its own registration;
    // the exact registration check below remains the authority.
    const child = spawn(codeCommand, ["--new-window", registration.workspace], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    const replacement = await waitForReplacementRegistration(registration, 35_000);
    if (!replacement) throw new Error(`No replacement workspace companion registered after stopping extension host ${pid}.`);
    console.log(`Restarted VS Code extension host ${pid} as ${replacement.pid} for workspace ${registration.workspace}`);
    return replacement;
  } catch (error) {
    throw new ClineConsoleError("EXTENSION_RESTART_FAILED", `Failed to spawn new VS Code process: ${(error as Error).message}`);
  }
}

/** Open an exact workspace and wait for its companion registration.  This is
 * intentionally separate from extension-host restart because an unexpectedly
 * closed window has no live PID that can safely be signalled. */
export async function openWorkspaceWindow(workspace: string, timeoutMs = 45_000, directory = runtimeDirectory()): Promise<WorkspaceRegistration> {
  const codeCommand = process.env.CLINE_CONSOLE_CODE_COMMAND?.trim() || "code";
  const child = spawn(codeCommand, ["--new-window", workspace], { detached: true, stdio: "ignore" });
  child.unref();
  const file = registrationPath(directory, workspaceId(workspace));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const registration = JSON.parse(await fs.readFile(file, "utf8")) as WorkspaceRegistration;
      if (registration.workspace === workspace && processExists(registration.pid)) return registration;
    } catch { /* registration is absent while VS Code starts */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new ClineConsoleError("WORKSPACE_REOPEN_FAILED", `VS Code did not register reopened workspace ${workspace} within ${timeoutMs}ms.`);
}

export async function waitForReplacementRegistration(registration: WorkspaceRegistration, timeoutMs: number, directory = runtimeDirectory()): Promise<WorkspaceRegistration | undefined> {
  const file = registrationPath(directory, registration.id);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const replacement = JSON.parse(await fs.readFile(file, "utf8")) as WorkspaceRegistration;
      if (replacement.workspace === registration.workspace && replacement.pid !== registration.pid && processExists(replacement.pid)) return replacement;
    } catch { /* registration is absent while the window reloads */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return undefined;
}

/**
 * Check if a process exists
 */
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Wait for a process to exit with timeout
 */
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Check if the extension is responsive by pinging it and checking for hung tasks
 */
export async function checkExtensionHealth(
  registration: WorkspaceRegistration,
  options?: Partial<HangupDetectionOptions>
): Promise<boolean> {
  try {
    const result = await detectExtensionHangup(registration, options);
    return !result.hung;
  } catch (error) {
    console.error(`Extension health check failed: ${(error as Error).message}`);
    return false;
  }
}
