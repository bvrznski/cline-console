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
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  try {
    if (fs.statSync(target).size > 5 * 1024 * 1024) fs.renameSync(target, `${target}.1`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const rank = { error: 0, info: 1, debug: 2 } as const;
  const write = (wanted: LogLevel, message: string): void => {
    if (rank[wanted] > rank[level]) return;
    fs.appendFileSync(target, `${new Date().toISOString()} ${wanted.toUpperCase()} ${message}\n`, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
  };
  return { error: message => write("error", message), info: message => write("info", message), debug: message => write("debug", message) };
}

export function combineLoggers(...loggers: Logger[]): Logger {
  return {
    error: message => loggers.forEach(logger => logger.error(message)),
    info: message => loggers.forEach(logger => logger.info(message)),
    debug: message => loggers.forEach(logger => logger.debug(message))
  };
}
