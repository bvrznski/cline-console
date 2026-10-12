import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const disposedTerminals = new WeakSet<object>();
export interface CleanupTerminal {
  name: string;
  processId: PromiseLike<number | undefined>;
  dispose(): void;
}

export interface TerminalCleanupResult { closed: number; passes: number; }

/** Validate actual process state; terminal display names are not ownership evidence. */
export async function isIdleWorkspaceShell(pid: number, workspace: string): Promise<boolean> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    const cwd = await fs.realpath(`/proc/${pid}/cwd`);
    const relative = path.relative(await fs.realpath(workspace), cwd);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    const shell = path.basename(await fs.readlink(`/proc/${pid}/exe`));
    if (!["bash", "zsh", "fish", "dash", "sh"].includes(shell)) return false;
    const { stdout } = await execute("ps", ["-eo", "ppid=,stat="], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
    return !stdout.split("\n").some(line => {
      const match = line.trim().match(/^(\d+)\s+(\S+)/);
      return match !== null && Number(match[1]) === pid && !match[2].startsWith("Z");
    });
  } catch { return false; }
}

export async function cleanupTaskTerminals(
  terminals: readonly CleanupTerminal[], workspace: string,
  idle = isIdleWorkspaceShell,
  protectedTerminal: (terminal: CleanupTerminal) => boolean = () => false
): Promise<number> {
  let closed = 0;
  const deadline = Date.now() + 5000;
  for (const terminal of terminals) {
    if (Date.now() >= deadline) break;
    if (disposedTerminals.has(terminal) || /^\[keep\]/i.test(terminal.name) || protectedTerminal(terminal)) continue;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pid = await Promise.race([
        terminal.processId,
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1000); })
      ]);
      if (pid && await idle(pid, workspace) && !protectedTerminal(terminal)) {
        disposedTerminals.add(terminal);
        terminal.dispose();
        closed++;
      }
    } catch { /* A closed terminal or unavailable process is not a queue failure. */ }
    finally { if (timer) clearTimeout(timer); }
  }
  return closed;
}

/**
 * Shell integration may publish task completion just before the PTY returns to
 * its prompt. Retry a bounded number of times so that this short teardown race
 * does not leave one terminal behind forever.
 */
export async function cleanupTaskTerminalsWithRetries(
  terminals: () => readonly CleanupTerminal[], workspace: string,
  idle = isIdleWorkspaceShell,
  protectedTerminal: (terminal: CleanupTerminal) => boolean = () => false,
  delaysMs: readonly number[] = [0, 1_000, 2_000]
): Promise<TerminalCleanupResult> {
  let closed = 0;
  let passes = 0;
  for (const delayMs of delaysMs) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    const candidates = terminals();
    if (!candidates.length) break;
    closed += await cleanupTaskTerminals(candidates, workspace, idle, protectedTerminal);
    passes++;
  }
  return { closed, passes };
}
