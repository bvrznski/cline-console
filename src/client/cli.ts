#!/usr/bin/env node
import path from "node:path";
import { promises as fs } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ClineConsoleError, errorMessage } from "../common/errors";
import { fileLogger, logFilePath } from "../common/logging";
import { VERSION } from "../common/version";
import type { ClineCapabilities, ClineStatus } from "../integrations/cline/types";
import { CANCEL_SUCCESS } from "./commands/cancel";
import { formatWorkspaces } from "./commands/list";
import { readInput } from "./commands/new";
import { formatStatus } from "./commands/status";
import { formatTasks, type WorkspaceTaskStatus } from "./commands/tasks";
import { formatExpandedRangeNotice, readTasks, splitTaskBatches, type ReadTasksOptions, type TaskFile } from "./commands/add";
import { promptForActiveTaskChoice } from "./commands/active_task_prompt";
import { promptForWaitingTaskChoice } from "./commands/waiting_task_prompt";
import { promptForDuplicateTaskConfirmation } from "./commands/duplicate_task_prompt";
import { formatQueue, formatQueues, type WorkspaceQueueStatus } from "./commands/queue";
import { formatSupervision, formatSupervisionReport, generateSupervisionReport, type WorkspaceSupervisionStatus } from "./commands/supervision";
import type { QueueStatus, QueueStatusItem } from "../ipc/types";
import type { QueueItem } from "../extension/task_queue";
import { invoke, loadRegistrations, parseWorkspaceSelection, resolveWorkspace, waitForWorkspaceRegistration } from "./ipc_client";
import { ClineConsoleService, probeService, serviceSocketPath } from "../service/daemon";
import { controlUserService, installUserService } from "../service/systemd";
import { color, configureCommandOutput, supportsColor } from "../common/terminal";
import { normalizeCommand, parseArgs } from "./grammar";
import { discoverPersistedQueueStatuses, reconcileQueueStatus } from "../extension/task_queue";
import { queueStateDirectory } from "../extension/workspace_registry";
import { runtimeDirectory } from "../extension/workspace_registry";
import { HistoryStore, historyDatabasePath } from "../history/history_store";
import { runWatch } from "./commands/watch";
import { queueScaleWarning } from "../common/queue_limits";

export { normalizeCommand, parseArgs } from "./grammar";

function readTaskOptions(parsed: { strictRange?: boolean; warnGaps?: boolean }): ReadTasksOptions {
  return {
    ...(parsed.strictRange !== undefined ? { strictRange: parsed.strictRange } : {}),
    ...(parsed.warnGaps !== undefined ? { warnGaps: parsed.warnGaps } : {})
  };
}

const HELP = `cline-console ${VERSION}

Usage:
  cline-console [--workspace PATH] --watch [--no-color]
  cline-console --workspace PATH --continue
  cline-console --workspace PATH --relaunch
  cline-console [OPTIONS] task start (--file FILE|--text TEXT|--stdin)
  cline-console [OPTIONS] task send (--file FILE|--text TEXT|--stdin)
  cline-console [OPTIONS] task status
  cline-console --workspace PATH task done
  cline-console --workspace PATH DONE
  cline-console [OPTIONS] tasks
  cline-console --workspace PATH tasks stop|reload|finish
  cline-console --workspace PATH queue add (FILE...|START_FILE - END|-f FILE...|--file FILE...|--from MANIFEST|--dir DIRECTORY [--newer-than FILE]) [--resume] [--strict-range] [--no-warn-gaps]
  cline-console --workspace PATH queue replace (FILE...|START_FILE - END|--file FILE...|--dir DIRECTORY [--newer-than FILE]) [--strict-range] [--no-warn-gaps]
  cline-console [OPTIONS] queue list
  cline-console --workspace PATH queue remove (--file PATH|--title TITLE|--id ID)
  cline-console --workspace PATH queue trim NUMBER
  cline-console --workspace PATH queue clear [--force]
  cline-console --workspace PATH queue pause|resume
  cline-console workspace list
  cline-console --workspace PATH workspace clear
  cline-console [--workspace PATH] history list [--limit NUMBER]
  cline-console history show TASK_ID
  cline-console history path
  cline-console [--workspace PATH|--global] supervision report
  cline-console service install|start|stop|restart|status|run

Options:
  -w, --workspace PATH   Select a VS Code workspace
  --global               Enable task execution supervision for all registered workspaces
  --json                 Emit machine-readable JSON where supported
  --no-color             Disable ANSI colors
  --timeout SECONDS      Set interactive prompt timeout
  --reflective BOOL      Override reflective mode for queued tasks (true|false)
  --scope PATH           Restrict queued-task edits to PATH
  --continue             Gently continue the current queue task in its thread
  --relaunch             Relaunch the current queue task from its original prompt

Queue add: -f/--fresh starts fresh when the persisted head is interrupted;
--force overrides current task and allows duplicates without hesitation.
--file and positional file input only append.
Range START - END expands sibling files by numeric suffix; extensions are
optional on either side (for example, 0.12.md - 0.20 or 0.13 - 2.15). When a
sibling roadmap or manifest exists, planned gaps are reported; --strict-range
requires every required planned phase file to exist.
  -V, --version          Print the version
  -h, --help             Show this help
`;

export async function run(argv = process.argv.slice(2)): Promise<number> {
  const normalized = normalizeCommand(parseArgs(argv));
  const parsed = normalized.parsed;
  configureCommandOutput(parsed.json, parsed.noColor);
  if (parsed.global && parsed.command !== "supervision") throw new Error("--global is valid only with supervision report.");
  if (parsed.reflective !== undefined && parsed.command !== "add" && parsed.command !== "replace") throw new Error("--reflective is valid only with queue add or queue replace.");
  if (parsed.scope !== undefined && parsed.command !== "add" && parsed.command !== "replace") throw new Error("--scope is valid only with queue add or queue replace.");
  if (parsed.noColor) process.env.NO_COLOR = "1";
  if (normalized.warning) process.stderr.write(`Warning: ${normalized.warning}\n`);
  if (!parsed.command || parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") { process.stdout.write(HELP); return 0; }
  if (parsed.command === "version") { process.stdout.write(`${VERSION}\n`); return 0; }
  if (parsed.command === "watch") {
    if (parsed.json || parsed.commandArgs.length) throw new Error("--watch accepts --workspace and --no-color, but no command or --json.");
    return runWatch(parsed.workspace);
  }
  if (parsed.command === "service") return runServiceCommand(parsed.commandArgs);
  if (parsed.command === "history") return runHistoryCommand(parsed.commandArgs, parsed.workspace, parsed.json);

  if (parsed.command === "continueQueue" || parsed.command === "relaunchQueue") {
    if (!parsed.workspace) throw new Error(`${parsed.command === "continueQueue" ? "--continue" : "--relaunch"} requires --workspace PATH.`);
    if (parsed.commandArgs.length) throw new Error(`${parsed.command === "continueQueue" ? "--continue" : "--relaunch"} accepts no arguments.`);
    const workspace = await fs.realpath(path.resolve(parsed.workspace));
    const target = { protocolVersion: 1 as const, id: "service-routed", workspace, socketPath: "", pid: process.pid, registeredAt: new Date().toISOString() };
    if (parsed.command === "continueQueue") {
      const result = await invoke(target, "continueQueue") as { continued: boolean; queueLength: number; sessionId?: string };
      process.stdout.write(parsed.json ? `${JSON.stringify({ workspace, ...result }, null, 2)}\n` : `Workspace: ${workspace}\nQueue continuation: ${result.continued ? "requested" : "nothing to continue"}\nQueue length: ${result.queueLength}\n`);
    } else {
      const result = await invoke(target, "relaunchQueue") as { relaunched: boolean; queueLength: number; previousSessionId?: string; sessionId?: string };
      process.stdout.write(parsed.json ? `${JSON.stringify({ workspace, ...result }, null, 2)}\n` : `Workspace: ${workspace}\nCurrent task: ${result.relaunched ? "relaunched from original prompt" : "no running task to relaunch"}\nQueue length: ${result.queueLength}\n`);
    }
    return 0;
  }

  // Handle supervision with --global BEFORE loading registrations and selectWorkspace
  if (parsed.command === "supervision" && parsed.global) {
    const operation = parsed.commandArgs[0];
    if (operation !== "report" && operation !== "--report") throw new Error("supervision accepts only report as an operation.");

    const registrations = await loadRegistrations();
    if (parsed.workspace) throw new Error("--global and --workspace are mutually exclusive.");

    const targets = registrations;
    if (!targets.length) {
      process.stdout.write(parsed.json ? "[]\n" : "No registered VS Code workspaces.\n");
      return 0;
    }

    // Get persisted queue statuses
    const persisted = await discoverPersistedQueueStatuses(queueStateDirectory());

    // Create a map of workspace -> queue items for supervision
    const allItems: { workspace: string; items: QueueItem[] }[] = [];
    for (const target of targets) {
      // Get queue status from the registered workspace
      let queueStatus: QueueStatus | undefined;
      try {
        queueStatus = await invoke(target, "queueStatus") as QueueStatus;
      } catch {
        // If we can't connect to this workspace, skip it
        continue;
      }

      // Get persisted items if available
      const persistedStatus = persisted.find(s => s.workspace === target.workspace);

      // Use the persisted status items for supervision report
      // Convert QueueStatusItem to QueueItem format (with empty prompt as placeholder)
      const items: QueueItem[] = (persistedStatus?.items ?? queueStatus.items).map(item => ({
        id: item.id,
        kind: item.kind,
        sourcePath: item.sourcePath,
        prompt: "",  // Placeholder - supervision doesn't need the actual prompt
        state: item.state as any,
        queuedAt: item.queuedAt,
        dispatchedAt: item.dispatchedAt,
        finishedAt: undefined,
        error: item.state === "failed" ? "Task failed" : undefined
      }));

      allItems.push({ workspace: target.workspace, items });
    }

    // Generate and display the global supervision report
    if (parsed.json) {
      const reports = allItems.map(item => ({
        workspace: item.workspace,
        report: generateSupervisionReport(item.items)
      }));
      process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
    } else {
      for (const item of allItems) {
        process.stdout.write(formatSupervisionReport(item.workspace, generateSupervisionReport(item.items)));
        process.stdout.write("\n");
      }
    }
    return 0;
  }

  const registrations = await loadRegistrations();
  if (parsed.command === "workspaces" || parsed.command === "list") { process.stdout.write(`${formatWorkspaces(registrations)}\n`); return 0; }
  if (parsed.command === "workspaceClear") {
    if (!parsed.workspace) throw new Error("workspace clear requires --workspace PATH.");
    const target = await resolveWorkspace(registrations, parsed.workspace, process.cwd());
    const result = await invoke(target, "clearWorkspace") as { cleared: number; clearedWaiting: number; clearedStaleRunning: number; queueLength: number; historyDeleted: number };
    process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: target.workspace, ...result }, null, 2)}\n` : `Workspace: ${target.workspace}\nCleared waiting items: ${result.clearedWaiting}\nCleared running items: ${result.clearedStaleRunning}\nCline history: preserved\nQueue length: ${result.queueLength}\n`);
    return 0;
  }
  if (parsed.command === "done") {
    if (!parsed.workspace) throw new Error("DONE requires --workspace PATH.");
    const target = await resolveWorkspace(registrations, parsed.workspace, process.cwd());
    const result = await invoke(target, "confirmCompletion") as { completed: boolean; id: string; title: string; queueLength: number };
    process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: target.workspace, ...result }, null, 2)}\n` : `Workspace: ${target.workspace}\nUser-confirmed complete: ${result.title}\nQueue length: ${result.queueLength}\n`);
    return 0;
  }
  if (parsed.command === "tasks") {
    const operation = parsed.commandArgs[0];
    if (operation === "stop" || operation === "reload" || operation === "finish") {
      if (!parsed.workspace) throw new Error(`tasks ${operation} requires --workspace PATH.`);
      if (parsed.commandArgs.length !== 1) throw new Error("tasks stop/reload/finish accepts no additional arguments.");
      const target = await resolveWorkspace(registrations, parsed.workspace, process.cwd());
      if (operation === "stop") {
        await invoke(target, "cancelTask");
        process.stdout.write(`Workspace: ${target.workspace}\nTask stopped through Cline's normal cancellation path.\n`);
      } else if (operation === "reload") {
        const result = await invoke(target, "reloadTask") as { taskReloaded: boolean; previousTaskId: string };
        process.stdout.write(`Workspace: ${target.workspace}\nTask reloaded from Cline history.\nPrevious task ID: ${result.previousTaskId}\n`);
      } else {
        const result = await invoke(target, "finishUnfinishedTasks") as { discovered: number; queued: number; skippedExisting: number; queueLength: number };
        process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: target.workspace, ...result }, null, 2)}\n` : `Workspace: ${target.workspace}\nUnfinished tasks discovered: ${result.discovered}\nQueued for completion: ${result.queued}\nAlready represented in queue history: ${result.skippedExisting}\nQueue length: ${result.queueLength}\n`);
      }
      return 0;
    }
    if (parsed.commandArgs.length) throw new Error("tasks accepts only stop, reload, or finish as an operation.");
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
    if (operation === "clear" || operation === "--clear" || operation === "pop" || operation === "--pop" || operation === "trim" || operation === "pause" || operation === "--pause" || operation === "resume" || operation === "--resume") {
      if (!parsed.workspace) throw new Error(`queue ${operation.replace(/^--/, "")} requires --workspace PATH.`);
      const target = await resolveWorkspace(registrations, parsed.workspace, process.cwd());
      if (operation.endsWith("clear")) {
        const force = parsed.commandArgs.length === 2 && parsed.commandArgs[1] === "--force";
        if (parsed.commandArgs.length !== 1 && !force) throw new Error("queue clear accepts only the optional --force flag.");
        const result = await invoke(target, "clearQueue", force ? { force: true } : undefined) as { cleared: number; clearedWaiting: number; clearedStaleRunning: number; queueLength: number; runningPreserved: boolean; historyDeleted: number };
        process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: target.workspace, ...result }, null, 2)}\n` : `Workspace: ${target.workspace}\nCleared waiting items: ${result.clearedWaiting}\nCleared running items: ${result.clearedStaleRunning}\n${force ? `Deleted Cline history tasks: ${result.historyDeleted}` : "Cline history: preserved"}\nQueue length: ${result.queueLength}\n`);
      } else if (operation.endsWith("pop")) {
        if ((parsed.commandArgs.length !== 2 && parsed.commandArgs.length !== 3) || !parsed.commandArgs[1]) throw new Error("queue remove requires one file path, displayed title, or queue ID.");
        const selector = parsed.commandArgs[1];
        const selectorType = parsed.commandArgs[2] as "file" | "title" | "id" | undefined;
        const result = await invoke(target, "popQueue", { selector, ...(selectorType !== "title" && selectorType !== "id" ? { resolvedSelector: path.resolve(selector) } : {}), ...(selectorType ? { selectorType } : {}) }) as { removed: boolean; id: string; title: string; sourcePath: string; queueLength: number };
        process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: target.workspace, ...result }, null, 2)}\n` : `Workspace: ${target.workspace}\nRemoved: ${result.title}\nSource: ${result.sourcePath}\nQueue length: ${result.queueLength}\n`);
      } else if (operation === "trim") {
        if (parsed.commandArgs.length !== 2 || !/^[1-9]\d*$/.test(parsed.commandArgs[1])) throw new Error("queue trim requires one positive integer.");
        const result = await invoke(target, "trimQueue", { keep: Number(parsed.commandArgs[1]) }) as { trimmed: number; kept: number; queueLength: number };
        process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: target.workspace, ...result }, null, 2)}\n` : `Workspace: ${target.workspace}\nTrimmed waiting items: ${result.trimmed}\nRetained active items: ${result.kept}\nQueue length: ${result.queueLength}\n`);
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
    if (parsed.commandArgs.length) throw new Error("queue accepts only clear, remove, trim, pause, or resume as an operation.");
    const persisted = await discoverPersistedQueueStatuses(queueStateDirectory());
    const targets = parsed.workspace ? await selectQueueTargets(registrations, persisted, parsed.workspace) : registrations;
    const queuesByWorkspace = new Map<string, WorkspaceQueueStatus>(persisted.map(status => {
      const companionConnected = registrations.some(registration => registration.workspace === status.workspace);
      return [status.workspace, { workspace: status.workspace, status: companionConnected ? status : reconcileQueueStatus(status, false), companionConnected }];
    }));
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
      const input = await readTasks(parsed.commandArgs, { ...readTaskOptions(parsed), workspaceDirectory: target.workspace });
      if (input.expandedRange?.length) process.stdout.write(formatExpandedRangeNotice(input.expandedRange, input.rangeGapReport));
      const added = await enqueueTasksWithDuplicateConfirmation(target, input.tasks, parsed.timeoutMs, false, parsed.force === true);
      queued = added.queued;
    }
    const result = await invoke(target, "resumeQueue") as { resumed: boolean; queueLength: number };
    if (parsed.json) process.stdout.write(`${JSON.stringify({ workspace: target.workspace, queued, ...result }, null, 2)}\n`);
    else process.stdout.write(`Workspace: ${target.workspace}\n${queued ? `Queued from files: ${queued}\n` : ""}Queue processing: ${result.resumed ? "resumed" : "nothing to resume"}\nQueue length: ${result.queueLength}\n`);
    return 0;
  }
  const selected = await selectWorkspace(registrations, parsed.workspace);
  if (parsed.command === "add") {
    const queueContext = await invoke(selected, "enqueueContext") as { active: boolean; sessionId?: string; status: "running" | "idle"; queueLength: number };
    const activity = queueContext.active ? queueContext
      : await invoke(selected, "activity") as { active: boolean; sessionId?: string; status: "running" | "waiting" | "idle" | "completed" | "failed" };
    const waitingChoice = activity.status === "waiting" ? await promptForWaitingTaskChoice(parsed.timeoutMs) : undefined;
    if (waitingChoice === "abort") {
      process.stdout.write("Aborted. No task file was read or added.\n");
      return 0;
    }
    const scopePath = parsed.scope ? await resolveTaskScope(parsed.scope, selected.workspace) : undefined;
    const input = await readTasks(parsed.commandArgs, { ...readTaskOptions(parsed), workspaceDirectory: selected.workspace });
    if (input.expandedRange?.length) process.stdout.write(formatExpandedRangeNotice(input.expandedRange, input.rangeGapReport));
    const tasks = input.tasks.map(task => ({ ...task, ...(parsed.reflective !== undefined ? { reflective: parsed.reflective } : {}), ...(scopePath ? { scopePath } : {}) }));
    const replacedHeadCount = (parsed.force || parsed.freshOnInterrupted) && queueContext.active ? 1 : 0;
    writeQueueScaleWarning(queueContext.queueLength - replacedHeadCount, tasks.length);
    if (waitingChoice === "resume") {
      await invoke(selected, "reloadTask");
      process.stdout.write("Incomplete task resumed from its original prompt.\n");
    } else if (waitingChoice === "skip") {
      if (!activity.sessionId) throw new Error("Waiting Cline task has no task ID and cannot be skipped safely.");
      await invoke(selected, "skipWaitingTask", { sessionId: activity.sessionId });
      process.stdout.write("Incomplete task skipped for queue processing.\n");
    }
    const result = await enqueueTasksWithDuplicateConfirmation(selected, tasks, parsed.timeoutMs, parsed.freshOnInterrupted === true, parsed.force === true);
    process.stdout.write(`Workspace: ${selected.workspace}\n${result.interruptedOverridden ? "Interrupted task overridden; fresh dispatch queued.\n" : ""}Queued: ${result.queued}\nQueue length: ${result.queueLength}\n`);
    if (parsed.resumeAfter) {
      const resumed = await invoke(selected, "resumeQueue") as { resumed: boolean; queueLength: number };
      process.stdout.write(`Queue processing: ${resumed.resumed ? "resumed" : "nothing to resume"}\n`);
    }
  } else if (parsed.command === "replace") {
    const scopePath = parsed.scope ? await resolveTaskScope(parsed.scope, selected.workspace) : undefined;
    const input = await readTasks(parsed.commandArgs, { ...readTaskOptions(parsed), workspaceDirectory: selected.workspace });
    if (input.expandedRange?.length) process.stdout.write(formatExpandedRangeNotice(input.expandedRange, input.rangeGapReport));
    const tasks = input.tasks.map(task => ({ ...task, ...(parsed.reflective !== undefined ? { reflective: parsed.reflective } : {}), ...(scopePath ? { scopePath } : {}) }));
    writeQueueScaleWarning(0, tasks.length, true);
    const result = await replaceQueueInBatches(selected, tasks);
    process.stdout.write(`Workspace: ${selected.workspace}\nReplaced waiting items: ${result.replaced}\nQueued: ${result.queued}\nQueue length: ${result.queueLength}\n`);
  } else if (parsed.command === "new") {
    if (isQueueReplacement(parsed.commandArgs)) {
      const input = await readTasks(parsed.commandArgs, { workspaceDirectory: selected.workspace });
      if (input.expandedRange?.length) process.stdout.write(formatExpandedRangeNotice(input.expandedRange));
      const result = await replaceQueueInBatches(selected, input.tasks);
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
      const result = await enqueueTasksWithDuplicateConfirmation(selected, [{ sourcePath, prompt }], parsed.timeoutMs, false, parsed.force === true);
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
   } else if (parsed.command === "supervision") {
     // Handle single workspace mode - selectWorkspace was already called above
     const operation = parsed.commandArgs[0];
     if (operation !== "report" && operation !== "--report") throw new Error("supervision accepts only report as an operation.");

     if (!parsed.workspace) throw new Error("supervision report requires --workspace PATH or --global.");
     if (parsed.global) throw new Error("--global and --workspace are mutually exclusive.");

     // supervision with --global was already handled earlier, so we're in single workspace mode
     const target = await resolveWorkspace(registrations, parsed.workspace, process.cwd());

     // Get queue status from the selected workspace
     const queueStatus = await invoke(target, "queueStatus") as QueueStatus;

     // Generate supervision report using the task_queue module's function
     const persisted = await discoverPersistedQueueStatuses(queueStateDirectory());
     const persistedStatus = persisted.find(s => s.workspace === target.workspace);

     // Use the persisted status items for supervision report
     // Convert QueueStatusItem to QueueItem format (with empty prompt as placeholder)
     const items = (persistedStatus?.items ?? queueStatus.items).map(item => ({
       id: item.id,
       kind: item.kind,
       sourcePath: item.sourcePath,
       prompt: "",  // Placeholder - supervision doesn't need the actual prompt
       state: item.state as any,
       queuedAt: item.queuedAt,
       dispatchedAt: item.dispatchedAt,
       finishedAt: undefined,
       error: item.state === "failed" ? "Task failed" : undefined
     }));
     const report = generateSupervisionReport(items);
     process.stdout.write(parsed.json ? `${JSON.stringify({ workspace: target.workspace, report }, null, 2)}\n` : formatSupervisionReport(target.workspace, report));
   } else throw new Error(`Unknown command: ${parsed.command}\n\n${HELP}`);
  return 0;
}

async function enqueueTasksWithDuplicateConfirmation(selected: Awaited<ReturnType<typeof selectWorkspace>>, tasks: Array<{ sourcePath: string; prompt: string; reflective?: boolean; scopePath?: string }>, timeoutMs?: number, freshOnInterrupted = false, force = false): Promise<{ queued: number; queueLength: number; interruptedOverridden?: boolean }> {
  let queued = 0, queueLength = 0, interruptedOverridden = false;
  const batches = splitTaskBatches(tasks);
  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    const fresh = freshOnInterrupted && index === 0;
    let result: { queued: number; queueLength: number; interruptedOverridden?: boolean };
    try {
      result = await invoke(selected, "enqueueTasks", { tasks: batch, allowDuplicates: force, force, ...(fresh ? { freshOnInterrupted: true } : {}) }) as typeof result;
    } catch (error) {
      if (!(error instanceof ClineConsoleError) || error.code !== "DUPLICATE_QUEUE_TASK") throw error;
      const confirmed = await promptForDuplicateTaskConfirmation(error.message, timeoutMs ?? 15_000);
      if (!confirmed) throw new ClineConsoleError("DUPLICATE_QUEUE_TASK_ABORTED", "Duplicate task was not added.");
      result = await invoke(selected, "enqueueTasks", { tasks: batch, allowDuplicates: true, force: true, ...(fresh ? { freshOnInterrupted: true } : {}) }) as typeof result;
    }
    queued += result.queued;
    queueLength = result.queueLength;
    interruptedOverridden ||= result.interruptedOverridden === true;
  }
  return { queued, queueLength, ...(interruptedOverridden ? { interruptedOverridden: true } : {}) };
}

function writeQueueScaleWarning(currentCount: number, addedCount: number, replace = false): void {
  const warning = queueScaleWarning(currentCount, addedCount, replace);
  if (warning) process.stderr.write(`Warning: ${warning}\n`);
}

async function replaceQueueInBatches(selected: Awaited<ReturnType<typeof selectWorkspace>>, tasks: Array<TaskFile & { reflective?: boolean; scopePath?: string }>): Promise<{ queued: number; replaced: number; queueLength: number }> {
  const [first, ...rest] = splitTaskBatches(tasks);
  if (!first) throw new ClineConsoleError("INVALID_PAYLOAD", "Queue replacement requires at least one task.");
  const initial = await invoke(selected, "replaceQueue", { tasks: first }) as { queued: number; replaced: number; queueLength: number };
  let queued = initial.queued, queueLength = initial.queueLength;
  for (const batch of rest) {
    const appended = await invoke(selected, "enqueueTasks", { tasks: batch, allowDuplicates: true }) as { queued: number; queueLength: number };
    queued += appended.queued;
    queueLength = appended.queueLength;
  }
  return { queued, replaced: initial.replaced, queueLength };
}

async function resolveTaskScope(value: string, workspace: string): Promise<string> {
  const scope = await fs.realpath(path.resolve(value));
  const stat = await fs.stat(scope);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`--scope must identify a regular file or directory: ${scope}`);
  const root = await fs.realpath(workspace);
  if (scope !== root && !scope.startsWith(`${root}${path.sep}`)) throw new Error(`--scope must be inside the selected workspace ${root}: ${scope}`);
  return scope;
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
  const positionalFiles = marker < 0 ? args : args.slice(marker + 1);
  if (positionalFiles.length === 3 && positionalFiles[1] === "-") return true;
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
      let stopping = false;
      const shutdown = (): void => {
        if (stopping) return;
        stopping = true;
        service.stop().then(resolve, reject);
      };
      process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
    });
    return 0;
  }
  throw new Error(`Unknown service action: ${action}`);
}

async function runHistoryCommand(args: string[], workspace: string | undefined, jsonOutput: boolean): Promise<number> {
  const action = args[0] ?? "list";
  if (action === "path" && args.length === 1) { process.stdout.write(`${historyDatabasePath()}\n`); return 0; }
  const store = new HistoryStore();
  try {
    if (action === "show") {
      if (args.length !== 2) throw new Error("history show requires one task ID.");
      const task = store.getTask(args[1]);
      if (!task) throw new Error(`No history task matches ${args[1]}.`);
      process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
      return 0;
    }
    if (action === "list") {
      let limit = 100;
      if (args.length > 1) {
        if (args.length !== 3 || args[1] !== "--limit" || !Number.isSafeInteger(Number(args[2])) || Number(args[2]) <= 0) throw new Error("history list accepts only --limit NUMBER.");
        limit = Number(args[2]);
      }
      let canonicalWorkspace = workspace;
      if (workspace) canonicalWorkspace = await fs.realpath(path.resolve(workspace));
      const tasks = store.listTasks(canonicalWorkspace, limit);
      if (jsonOutput) process.stdout.write(`${JSON.stringify(tasks, null, 2)}\n`);
      else process.stdout.write(`${formatHistoryTasks(tasks)}\n`);
      return 0;
    }
    throw new Error("history accepts list, show, or path.");
  } finally { store.close(); }
}

function formatHistoryTasks(tasks: Array<Record<string, unknown>>): string {
  if (!tasks.length) return "No cline-console history records found.";
  const rows = tasks.map(task => [String(task.id), String(task.state ?? "recorded"), String(task.title), String(task.workspace), String(task.source_path)]);
  const headers = ["ID", "State", "Title", "Workspace", "Source"];
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index].length)));
  const line = (row: string[]) => row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd();
  return [line(headers), widths.map(width => "-".repeat(width)).join("  "), ...rows.map(line)].join("\n");
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
