import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type LogLevel = "error" | "info" | "debug";

export interface Logger {
  error(message: string): void;
  info(message: string): void;
  debug(message: string): void;
}

export function consoleLogger(level: LogLevel = "info"): Logger {
  const rank = { error: 0, info: 1, debug: 2 } as const;
  const emit = (wanted: LogLevel, message: string): void => {
    if (rank[wanted] <= rank[level]) process.stderr.write(`[cline-console] ${message}\n`);
  };
  return { error: m => emit("error", m), info: m => emit("info", m), debug: m => emit("debug", m) };
}

export function logFilePath(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "cline-console", "cline-console.log");
}

export function fileLogger(level: LogLevel = "info"): Logger {
  const target = logFilePath();
  const directory = path.dirname(target);
  let fileAvailable = true;
  let failureReported = false;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    try {
      if (fs.statSync(target).size > 5 * 1024 * 1024) fs.renameSync(target, `${target}.1`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  } catch (error) {
    fileAvailable = false;
    reportFileFailure(target, error);
    failureReported = true;
  }
  const rank = { error: 0, info: 1, debug: 2 } as const;
  const write = (wanted: LogLevel, message: string): void => {
    if (rank[wanted] > rank[level]) return;
    if (fileAvailable) {
      try {
        fs.appendFileSync(target, `${new Date().toISOString()} ${wanted.toUpperCase()} ${message}\n`, { mode: 0o600 });
        fs.chmodSync(target, 0o600);
        return;
      } catch (error) {
        fileAvailable = false;
        if (!failureReported) reportFileFailure(target, error);
        failureReported = true;
      }
    }
    safeStderr(`[cline-console] ${wanted.toUpperCase()} ${message}\n`);
  };
  return { error: message => write("error", message), info: message => write("info", message), debug: message => write("debug", message) };
}

export function combineLoggers(...loggers: Logger[]): Logger {
  const emit = (level: keyof Logger, message: string): void => {
    for (const logger of loggers) {
      try { logger[level](message); }
      catch (error) { safeStderr(`[cline-console] Logger ${level} sink failed: ${String(error)}\n`); }
    }
  };
  return {
    error: message => emit("error", message),
    info: message => emit("info", message),
    debug: message => emit("debug", message)
  };
}

function reportFileFailure(target: string, error: unknown): void {
  safeStderr(`[cline-console] File logging unavailable at ${target}: ${String(error)}; using stderr.\n`);
}

function safeStderr(message: string): void {
  try { process.stderr.write(message); } catch { /* Logging must never terminate the daemon. */ }
}
