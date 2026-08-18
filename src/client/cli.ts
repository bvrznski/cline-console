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
import { promptForWaitingTaskChoice } from "./commands/waiting_task_prompt";
import { formatQueue, formatQueues, type WorkspaceQueueStatus } from "./commands/queue";
import type { QueueStatus } from "../ipc/types";
import { invoke, loadRegistrations, parseWorkspaceSelection, resolveWorkspace, waitForWorkspaceRegistration } from "./ipc_client";
import { ClineConsoleService, probeService, serviceSocketPath } from "../service/daemon";
import { controlUserService, installUserService } from "../service/systemd";
import { color, supportsColor } from "../common/terminal";
import { normalizeCommand, parseArgs } from "./grammar";
import { discoverPersistedQueueStatuses } from "../extension/task_queue";
import { runtimeDirectory } from "../extension/workspace_registry";

export { normalizeCommand, parseArgs } from "./grammar";

const HELP = `cline-console ${VERSION}

Usage:
  cline-console [OPTIONS] task start (--file FILE|--text TEXT|--stdin)
  cline-console [OPTIONS] task send (--file FILE|--text TEXT|--stdin)
  cline-console [OPTIONS] task status
  cline-console [OPTIONS] tasks
  cline-console --workspace PATH tasks stop|reload
  cline-console --workspace PATH queue add (--file FILE...|--dir DIRECTORY [--newer-than FILE]) [--resume]
  cline-console --workspace PATH queue replace (--file FILE...|--dir DIRECTORY [--newer-than FILE])
  cline-console [OPTIONS] queue list
  cline-console --workspace PATH queue remove (--file PATH|--title TITLE|--id ID)
  cline-console --workspace PATH queue clear|pause|resume
  cline-console workspace list
  cline-console --workspace PATH workspace clear
  cline-console service install|start|stop|restart|status|run

Options:
  -w, --workspace PATH   Select a VS Code workspace
  --json                 Emit machine-readable JSON where supported
  --no-color             Disable ANSI colors
  --timeout SECONDS      Set interactive prompt timeout
  -V, --version          Print the version
  -h, --help             Show this help
`;

export async function run(argv = process.argv.slice(2)): Promise<number> {
  const normalized = normalizeCommand(parseArgs(argv));
  const parsed = normalized.parsed;
  if (parsed.noColor) process.env.NO_COLOR = "1";
  if (normalized.warning) process.stderr.write(`Warning: ${normalized.warning}\n`);
  if (!parsed.command || parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") { process.stdout.write(HELP); return 0; }
  if (parsed.command === "version") { process.stdout.write(`${VERSION}\n`); return 0; }
  if (parsed.command === "service") return runServiceCommand(parsed.commandArgs);
  const registrations = await loadRegistrations();
  if (parsed.command === "workspaces" || parsed.command === "list") { process.stdout.write(`${formatWorkspaces(registrations)}\n`); return 0; }
  if (parsed.command === "workspaceClear") {
    if (!parsed.workspace) throw new Error("workspace clear requires --workspace PATH.");
    const target = await resolveWorkspace(registrations, parsed.workspace, process.cwd());
    const result = await invoke(target, "clearWorkspace") as { cleared: number; clearedWaiting: number; clearedStaleRunning: number; queueLength: number; historyDeleted: number };
    process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: target.workspace, ...result }, null, 2)}\n` : `Workspace: ${target.workspace}\nCleared waiting items: ${result.clearedWaiting}\nCleared running items: ${result.clearedStaleRunning}\nDeleted workspace Cline history tasks: ${result.historyDeleted}\nQueue length: ${result.queueLength}\n`);
    return 0;
  }
  if (parsed.command === "tasks") {
    const operation = parsed.commandArgs[0];
    if (operation === "stop" || operation === "reload") {
      if (!parsed.workspace) throw new Error(`tasks ${operation} requires --workspace PATH.`);
      if (parsed.commandArgs.length !== 1) throw new Error("tasks stop/reload accepts no additional arguments.");
      const target = await resolveWorkspace(registrations, parsed.workspace, process.cwd());
      if (operation === "stop") {
        await invoke(target, "cancelTask");
        process.stdout.write(`Workspace: ${target.workspace}\nTask stopped through Cline's normal cancellation path.\n`);
      } else {
        const result = await invoke(target, "reloadTask") as { taskReloaded: boolean; previousTaskId: string };
        process.stdout.write(`Workspace: ${target.workspace}\nTask reloaded from Cline history.\nPrevious task ID: ${result.previousTaskId}\n`);
      }
      return 0;
    }
    if (parsed.commandArgs.length) throw new Error("tasks accepts only stop or reload as an operation.");
    const targets = parsed.workspace ? [await resolveWorkspace(registrations, parsed.workspace, process.cwd())] : registrations;
    const tasks: WorkspaceTaskStatus[] = await Promise.all(targets.map(async registration => {
      try { return { workspace: registration.workspace, status: await invoke(registration, "status") as ClineStatus }; }
      catch (error) { return { workspace: registration.workspace, error: errorMessage(error) }; }
    }));
    process.stdout.write(parsed.json ? `${JSON.stringify(tasks, null, 2)}\n` : `${formatTasks(tasks)}\n`);
    return tasks.some(item => item.error) ? 1 : 0;
  }
  if (parsed.command === "queue") {
    const operation = parsed.commandArgs[0];
    if (operation === "clear" || operation === "--clear" || operation === "pop" || operation === "--pop" || operation === "pause" || operation === "--pause" || operation === "resume" || operation === "--resume") {
      if (!parsed.workspace) throw new Error(`queue ${operation.replace(/^--/, "")} requires --workspace PATH.`);
      const target = await resolveWorkspace(registrations, parsed.workspace, process.cwd());
      if (operation.endsWith("clear")) {
        if (parsed.commandArgs.length !== 1) throw new Error("queue clear accepts no additional arguments.");
        const result = await invoke(target, "clearQueue") as { cleared: number; clearedWaiting: number; clearedStaleRunning: number; queueLength: number; runningPreserved: boolean; historyDeleted: number };
        process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: target.workspace, ...result }, null, 2)}\n` : `Workspace: ${target.workspace}\nCleared waiting items: ${result.clearedWaiting}\nCleared running items: ${result.clearedStaleRunning}\nDeleted Cline history tasks: ${result.historyDeleted}\nQueue length: ${result.queueLength}\n`);
      } else if (operation.endsWith("pop")) {
        if ((parsed.commandArgs.length !== 2 && parsed.commandArgs.length !== 3) || !parsed.commandArgs[1]) throw new Error("queue remove requires one file path, displayed title, or queue ID.");
        const selector = parsed.commandArgs[1];
        const selectorType = parsed.commandArgs[2] as "file" | "title" | "id" | undefined;
        const result = await invoke(target, "popQueue", { selector, ...(selectorType !== "title" && selectorType !== "id" ? { resolvedSelector: path.resolve(selector) } : {}), ...(selectorType ? { selectorType } : {}) }) as { removed: boolean; id: string; title: string; sourcePath: string; queueLength: number };
        process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: target.workspace, ...result }, null, 2)}\n` : `Workspace: ${target.workspace}\nRemoved: ${result.title}\nSource: ${result.sourcePath}\nQueue length: ${result.queueLength}\n`);
      } else if (operation.endsWith("pause")) {
        if (parsed.commandArgs.length !== 1) throw new Error("queue pause accepts no additional arguments.");
        const result = await invoke(target, "pauseQueue") as { paused: boolean; queueLength: number; runningPreserved: boolean };
        process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: target.workspace, ...result }, null, 2)}\n` : `Workspace: ${target.workspace}\nQueue processing: paused after current task\nRunning item preserved: ${result.runningPreserved ? "yes" : "no"}\nQueue length: ${result.queueLength}\n`);
      } else {
        if (parsed.commandArgs.length !== 1) throw new Error("queue resume accepts no additional arguments.");
        const result = await invoke(target, "resumeQueue") as { resumed: boolean; queueLength: number };
        process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: target.workspace, ...result }, null, 2)}\n` : `Workspace: ${target.workspace}\nQueue processing: ${result.resumed ? "resumed" : "nothing to resume"}\nQueue length: ${result.queueLength}\n`);
      }
      return 0;
    }
    if (parsed.commandArgs.length) throw new Error("queue accepts only clear, pop, pause, or resume as an operation.");
    const persisted = await discoverPersistedQueueStatuses(runtimeDirectory());
    const targets = parsed.workspace ? await selectQueueTargets(registrations, persisted, parsed.workspace) : registrations;
    const queuesByWorkspace = new Map<string, WorkspaceQueueStatus>(persisted.map(status => [status.workspace, {
      workspace: status.workspace, status, companionConnected: registrations.some(registration => registration.workspace === status.workspace)
    }]));
    const connectedQueues: WorkspaceQueueStatus[] = await Promise.all(targets.map(async registration => {
      try { return { workspace: registration.workspace, status: await invoke(registration, "queueStatus") as QueueStatus }; }
      catch (error) { return { workspace: registration.workspace, error: errorMessage(error) }; }
    }));
    for (const item of connectedQueues) queuesByWorkspace.set(item.workspace, { ...item, companionConnected: true });
    const queues = parsed.workspace
      ? [...queuesByWorkspace.values()].filter(item => queueWorkspaceMatches(item.workspace, parsed.workspace!) || targets.some(target => target.workspace === item.workspace))
      : [...queuesByWorkspace.values()].sort((left, right) => left.workspace.localeCompare(right.workspace));
    if (parsed.workspace && !queues.length) throw new Error(`No registered or persisted queue matches ${parsed.workspace}.`);
    if (parsed.json) process.stdout.write(`${JSON.stringify(parsed.workspace ? queueJson(queues[0]) : queues.map(queueJson), null, 2)}\n`);
    else process.stdout.write(`${parsed.workspace && queues[0]?.status ? formatQueue(queues[0].status, supportsColor(), queues[0].companionConnected) : formatQueues(queues)}\n`);
    return queues.some(item => item.error) ? 1 : 0;
  }
  if (parsed.command === "resume") {
    if (!parsed.workspace) throw new Error("resume requires --workspace PATH.");
    const target = await resolveWorkspace(registrations, parsed.workspace, process.cwd());
    let queued = 0;
    if (parsed.commandArgs.length) {
      const tasks = await readTasks(parsed.commandArgs);
      const added = await invoke(target, "enqueueTasks", { tasks }) as { queued: number; queueLength: number };
      queued = added.queued;
    }
    const result = await invoke(target, "resumeQueue") as { resumed: boolean; queueLength: number };
    if (parsed.json) process.stdout.write(`${JSON.stringify({ workspace: target.workspace, queued, ...result }, null, 2)}\n`);
    else process.stdout.write(`Workspace: ${target.workspace}\n${queued ? `Queued from files: ${queued}\n` : ""}Queue processing: ${result.resumed ? "resumed" : "nothing to resume"}\nQueue length: ${result.queueLength}\n`);
    return 0;
  }
  const selected = await selectWorkspace(registrations, parsed.workspace);
  if (parsed.command === "add") {
    const activity = await invoke(selected, "activity") as { active: boolean; sessionId?: string; status?: "running" | "waiting" | "idle" | "completed" | "failed" };
    const waitingChoice = activity.status === "waiting" ? await promptForWaitingTaskChoice(parsed.timeoutMs) : undefined;
    if (waitingChoice === "abort") {
      process.stdout.write("Aborted. No task file was read or added.\n");
      return 0;
    }
    const tasks = await readTasks(parsed.commandArgs);
    if (waitingChoice === "resume") {
      await invoke(selected, "reloadTask");
      process.stdout.write("Incomplete task resumed from its original prompt.\n");
    } else if (waitingChoice === "skip") {
      if (!activity.sessionId) throw new Error("Waiting Cline task has no task ID and cannot be skipped safely.");
      await invoke(selected, "skipWaitingTask", { sessionId: activity.sessionId });
      process.stdout.write("Incomplete task skipped for queue processing.\n");
    }
    const result = await invoke(selected, "enqueueTasks", { tasks }) as { queued: number; queueLength: number };
    process.stdout.write(`Workspace: ${selected.workspace}\nQueued: ${result.queued}\nQueue length: ${result.queueLength}\n`);
    if (parsed.resumeAfter) {
      const resumed = await invoke(selected, "resumeQueue") as { resumed: boolean; queueLength: number };
      process.stdout.write(`Queue processing: ${resumed.resumed ? "resumed" : "nothing to resume"}\n`);
    }
  } else if (parsed.command === "replace") {
    const tasks = await readTasks(parsed.commandArgs);
    const result = await invoke(selected, "replaceQueue", { tasks }) as { queued: number; replaced: number; queueLength: number };
    process.stdout.write(`Workspace: ${selected.workspace}\nReplaced waiting items: ${result.replaced}\nQueued: ${result.queued}\nQueue length: ${result.queueLength}\n`);
  } else if (parsed.command === "new") {
    if (isQueueReplacement(parsed.commandArgs)) {
      const tasks = await readTasks(parsed.commandArgs);
      const result = await invoke(selected, "replaceQueue", { tasks }) as { queued: number; replaced: number; queueLength: number };
      process.stdout.write(`Workspace: ${selected.workspace}\nReplaced waiting items: ${result.replaced}\nQueued: ${result.queued}\nQueue length: ${result.queueLength}\n`);
      return 0;
    }
    const activity = await invoke(selected, "activity") as { active: boolean; sessionId?: string; status?: string };
    const choice = activity.status === "running" || activity.status === "waiting" ? await promptForActiveTaskChoice(parsed.timeoutMs) : "replace";
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
    const activity = await invoke(selected, "activity") as { active: boolean; sessionId?: string; status?: "running" | "waiting" | "idle" | "completed" | "failed" };
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

async function selectQueueTargets(registrations: Awaited<ReturnType<typeof loadRegistrations>>, persisted: QueueStatus[], selection: string) {
  try {
    return [await resolveWorkspace(registrations, selection, process.cwd())];
  } catch (error) {
    if (persisted.some(status => queueWorkspaceMatches(status.workspace, selection))) return [];
    try { return [await waitForWorkspaceRegistration(selection, process.cwd())]; }
    catch { throw error; }
  }
}

function queueWorkspaceMatches(workspace: string, selection: string): boolean {
  return path.resolve(workspace) === path.resolve(selection);
}

function queueJson(item: WorkspaceQueueStatus): object {
  return item.status ? { ...item.status, companionConnected: item.companionConnected ?? false } : { workspace: item.workspace, companionConnected: item.companionConnected ?? false, error: item.error };
}

async function newTaskSourcePath(args: string[]): Promise<string> {
  return inputSourcePath(args);
}

function isQueueReplacement(args: string[]): boolean {
  if (args.includes("-d") || args.includes("--directory")) return true;
  const marker = args.findIndex(arg => arg === "-f" || arg === "--file");
  return marker >= 0 && args.slice(marker + 1).length > 1;
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
  const colors = supportsColor();
  return `Cline: ${version ?? "unknown"} Legacy\n\nnew task       ${yes(c.newTask, colors)}\nfollow-up      ${yes(c.followup, colors)}\ncancel         ${yes(c.cancel, colors)}\nstatus         ${color(c.taskStatus ? "yes" : "partial", c.taskStatus ? "green" : "yellow", colors)}\ndirect API     ${yes(c.directApi, colors)}\ncommand API    ${yes(c.commandApi, colors)}\ninternal API   ${color("no", "red", colors)}\n`;
}
const yes = (value: boolean, colors: boolean): string => color(value ? "yes" : "no", value ? "green" : "red", colors);

if (require.main === module) {
  const logger = fileLogger("info");
  logger.info(summarizeInvocation(process.argv.slice(2)));
  run().then(code => { logger.info(`CLI completed with exit code ${code}. Log: ${logFilePath()}`); process.exitCode = code; })
    .catch(error => { logger.error(`CLI failed: ${errorMessage(error)}`); process.stderr.write(`${color("cline-console: ERROR:", "red")} ${errorMessage(error)}\n`); process.exitCode = 1; });
}

export function summarizeInvocation(argv: string[]): string {
  const parsed = parseArgs(argv);
  return `CLI invoked: command=${parsed.command ?? "help"} workspace=${parsed.workspace ? "specified" : "automatic"} argumentCount=${parsed.commandArgs.length} json=${parsed.json}`;
}
