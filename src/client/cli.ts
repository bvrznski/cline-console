#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline/promises";
import { errorMessage } from "../common/errors";
import { fileLogger, logFilePath } from "../common/logging";
import { VERSION } from "../common/version";
import type { ClineCapabilities, ClineStatus } from "../integrations/cline/types";
import { CANCEL_SUCCESS } from "./commands/cancel";
import { formatWorkspaces } from "./commands/list";
import { readInput } from "./commands/new";
import { formatStatus } from "./commands/status";
import { formatTasks, type WorkspaceTaskStatus } from "./commands/tasks";
import { readTasks } from "./commands/add";
import { promptForActiveTaskChoice } from "./commands/active_task_prompt";
import { invoke, loadRegistrations, parseWorkspaceSelection, resolveWorkspace } from "./ipc_client";
import { ClineConsoleService, probeService, serviceSocketPath } from "../service/daemon";
import { controlUserService, installUserService } from "../service/systemd";

const HELP = `cline-console ${VERSION}

Usage:
  cline-console [--workspace PATH] new -f FILE
  cline-console [--workspace PATH] new "prompt text"
  cline-console [--workspace PATH] send -f FILE
  cline-console [--workspace PATH] send "message"
  cline-console --workspace PATH add -f TASK_FILE [TASK_FILE ...]
  cline-console --workspace PATH add -d DIRECTORY
  cline-console [--workspace PATH] cancel
  cline-console [--workspace PATH] status [--json]
  cline-console [--workspace PATH] tasks [--json]
  cline-console tasks [--json]
  cline-console workspaces
  cline-console capabilities
  cline-console service install|start|stop|restart|status|run
`;

interface Parsed { workspace?: string; json: boolean; command?: string; commandArgs: string[]; }

export function parseArgs(argv: string[]): Parsed {
  let workspace: string | undefined, json = false, command: string | undefined;
  const commandArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") { workspace = argv[++i]; if (!workspace) throw new Error("--workspace requires a path."); continue; }
    if (arg === "--json") { json = true; continue; }
    if (!command) command = arg; else commandArgs.push(arg);
  }
  return { workspace, json, command, commandArgs };
}

export async function run(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.command === "help" || parsed.command === "--help") { process.stdout.write(HELP); return 0; }
  if (parsed.command === "service") return runServiceCommand(parsed.commandArgs);
  const registrations = await loadRegistrations();
  if (parsed.command === "workspaces" || parsed.command === "list") { process.stdout.write(`${formatWorkspaces(registrations)}\n`); return 0; }
  if (parsed.command === "tasks") {
    const targets = parsed.workspace ? [await resolveWorkspace(registrations, parsed.workspace, process.cwd())] : registrations;
    const tasks: WorkspaceTaskStatus[] = await Promise.all(targets.map(async registration => {
      try { return { workspace: registration.workspace, status: await invoke(registration, "status") as ClineStatus }; }
      catch (error) { return { workspace: registration.workspace, error: errorMessage(error) }; }
    }));
    process.stdout.write(parsed.json ? `${JSON.stringify(tasks, null, 2)}\n` : `${formatTasks(tasks)}\n`);
    return tasks.some(item => item.error) ? 1 : 0;
  }
  const selected = await selectWorkspace(registrations, parsed.workspace);
  if (parsed.command === "add") {
    const tasks = await readTasks(parsed.commandArgs);
    const result = await invoke(selected, "enqueueTasks", { tasks }) as { queued: number; queueLength: number };
    process.stdout.write(`Workspace: ${selected.workspace}\nQueued: ${result.queued}\nQueue length: ${result.queueLength}\n`);
  } else if (parsed.command === "new") {
    const activity = await invoke(selected, "activity") as { active: boolean; sessionId?: string; status?: string };
    const choice = activity.status === "running" ? await promptForActiveTaskChoice() : "replace";
    if (choice === "abort") {
      process.stdout.write("Aborted. No task was read, queued, or submitted.\n");
      return 0;
    }
    const prompt = await readInput(parsed.commandArgs);
    if (choice === "queue") {
      const sourcePath = await newTaskSourcePath(parsed.commandArgs);
      const result = await invoke(selected, "enqueueTasks", { tasks: [{ sourcePath, prompt }] }) as { queued: number; queueLength: number };
      process.stdout.write(`Workspace: ${selected.workspace}\nQueued: ${result.queued}\nQueue length: ${result.queueLength}\n`);
    } else {
      await invoke(selected, "newTask", { prompt });
      process.stdout.write(`Workspace: ${selected.workspace}\nTask started successfully.\n`);
    }
  } else if (parsed.command === "send") {
    const activity = await invoke(selected, "activity") as { active: boolean; sessionId?: string; status?: "running" | "idle" | "completed" | "failed" };
    if (!activity.active || !activity.sessionId) throw new Error("No Cline task exists in this workspace. Start one with 'new' first.");
    const message = await readInput(parsed.commandArgs);
    if (activity.status === "running") {
      const sourcePath = await inputSourcePath(parsed.commandArgs);
      const result = await invoke(selected, "enqueueMessages", { messages: [{ sourcePath, message, sessionId: activity.sessionId }] }) as { queued: number; queueLength: number };
      process.stdout.write(`Workspace: ${selected.workspace}\nMessage queued for the active task.\nQueue length: ${result.queueLength}\n`);
    } else {
      await invoke(selected, "sendMessage", { message });
      process.stdout.write("Message sent to completed Cline task.\n");
    }
  } else if (parsed.command === "cancel") {
    await invoke(selected, "cancelTask"); process.stdout.write(`${CANCEL_SUCCESS}\n`);
  } else if (parsed.command === "status") {
    const status = await invoke(selected, "status") as ClineStatus;
    process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: selected.workspace, ...status }, null, 2)}\n` : `${formatStatus(selected.workspace, status)}\n`);
  } else if (parsed.command === "capabilities") {
    const result = await invoke(selected, "capabilities") as { version?: string; capabilities: ClineCapabilities };
    process.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatCapabilities(result.version, result.capabilities));
  } else throw new Error(`Unknown command: ${parsed.command}\n\n${HELP}`);
  return 0;
}

async function newTaskSourcePath(args: string[]): Promise<string> {
  return inputSourcePath(args);
}

async function inputSourcePath(args: string[]): Promise<string> {
  const marker = args.findIndex(arg => arg === "-f" || arg === "--file");
  if (marker >= 0 && args[marker + 1]) return fs.realpath(path.resolve(args[marker + 1]));
  return "<inline-or-stdin>";
}

async function selectWorkspace(registrations: Awaited<ReturnType<typeof loadRegistrations>>, explicit?: string) {
  if (explicit) return resolveWorkspace(registrations, explicit, process.cwd());
  if (!registrations.length) return resolveWorkspace(registrations, undefined, process.cwd());
  if (registrations.length === 1) return registrations[0];
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Multiple VS Code workspaces are registered. Interactive selection requires a terminal, or use --workspace PATH.");
  process.stdout.write("Multiple VS Code workspaces are registered:\n\n");
  registrations.forEach((registration, index) => process.stdout.write(`  ${index + 1}) ${registration.workspace}\n`));
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question("\nSelect workspace number (empty to cancel): ");
    const selected = parseWorkspaceSelection(registrations, answer);
    if (!selected) throw new Error("Workspace selection cancelled or invalid; no action was performed.");
    return selected;
  } finally { readline.close(); }
}

async function runServiceCommand(args: string[]): Promise<number> {
  const action = args[0] ?? "status";
  if (action === "install") {
    const target = await installUserService(path.resolve(process.argv[1]));
    process.stdout.write(`Installed and started singleton service: ${target}\n`);
    return 0;
  }
  if (action === "start" || action === "stop" || action === "restart") {
    await controlUserService(action);
    process.stdout.write(`Service ${action} requested.\n`);
    return 0;
  }
  if (action === "status") {
    const running = await probeService();
    process.stdout.write(`Service: ${running ? "running" : "stopped"}\nSocket: ${serviceSocketPath()}\n`);
    return running ? 0 : 1;
  }
  if (action === "run") {
    const logger = fileLogger("info"), service = new ClineConsoleService(logger);
    await service.start();
    await new Promise<void>((resolve, reject) => {
      const shutdown = (): void => { service.stop().then(resolve, reject); };
      process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
    });
    return 0;
  }
  throw new Error(`Unknown service action: ${action}`);
}

function formatCapabilities(version: string | undefined, c: ClineCapabilities): string {
  return `Cline: ${version ?? "unknown"} Legacy\n\nnew task       ${yes(c.newTask)}\nfollow-up      ${yes(c.followup)}\ncancel         ${yes(c.cancel)}\nstatus         ${c.taskStatus ? "yes" : "partial"}\ndirect API     ${yes(c.directApi)}\ncommand API    ${yes(c.commandApi)}\ninternal API   no\n`;
}
const yes = (value: boolean): string => value ? "yes" : "no";

if (require.main === module) {
  const logger = fileLogger("info");
  logger.info(summarizeInvocation(process.argv.slice(2)));
  run().then(code => { logger.info(`CLI completed with exit code ${code}. Log: ${logFilePath()}`); process.exitCode = code; })
    .catch(error => { logger.error(`CLI failed: ${errorMessage(error)}`); process.stderr.write(`cline-console: ERROR: ${errorMessage(error)}\n`); process.exitCode = 1; });
}

export function summarizeInvocation(argv: string[]): string {
  const parsed = parseArgs(argv);
  return `CLI invoked: command=${parsed.command ?? "help"} workspace=${parsed.workspace ? "specified" : "automatic"} argumentCount=${parsed.commandArgs.length} json=${parsed.json}`;
}
