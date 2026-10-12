import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import { combineLoggers, fileLogger, type Logger, type LogLevel } from "../common/logging";
import { createClineAdapter } from "../integrations/cline/adapter";
import { registerCommands } from "./commands";
import { IpcServer } from "./server";
import { migrateRuntimeQueueState, queueStatePath, runtimeDirectory, workspaceId } from "./workspace_registry";
import { DEFAULT_TASK_SCANNER_OPTIONS, TaskQueue, type TaskScannerOptions } from "./task_queue";
import { HistoryStore } from "../history/history_store";
import { cleanupTaskTerminalsWithRetries } from "./terminal_cleanup";
import { cleanupTaskTabs } from "./tab_cleanup";
import { containsInteractiveSudo, showSudoZenityPrompt } from "./sudo_prompt";
import { waitForLmStudio } from "./lmstudio_ready";

let activeServer: IpcServer | undefined;
let activeQueue: TaskQueue | undefined;
let activeHistory: HistoryStore | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("Cline Console", { log: true });
  context.subscriptions.push(output);
  const config = vscode.workspace.getConfiguration("cline-console");
  const level = config.get<LogLevel>("logLevel", "info");
  const rank = { error: 0, info: 1, debug: 2 } as const;
  const outputLogger: Logger = {
    error: message => output.error(message),
    info: message => { if (rank.info <= rank[level]) output.info(message); },
    debug: message => { if (rank.debug <= rank[level]) output.debug(message); }
  };
  const logger = combineLoggers(outputLogger, fileLogger(level));
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspacePath) { logger.info("No filesystem workspace is open; IPC server was not started."); return; }
  const workspace = await fs.realpath(workspacePath);
  const scannerConfig = vscode.workspace.getConfiguration("cline-console", vscode.Uri.file(workspace));
  const directory = runtimeDirectory(config.get<string>("socketDirectory", ""));
  const adapter = createClineAdapter(logger);
  try {
    activeHistory = new HistoryStore();
    activeHistory.registerWorkspace(workspace, { vscodeVersion: vscode.version, extensionVersion: context.extension.packageJSON.version, nodeVersion: process.version, platform: process.platform, architecture: process.arch });
    activeHistory.recordPromptSnapshot(workspace, "system_prompt", undefined, "cline-runtime-private", await adapter.getVersion(), undefined, { availability: "not_exposed_by_public_api", clineConsolePolicy: "capture_full_content_when_observable" });
  } catch (error) { logger.error(`SQLite history is unavailable; queue compatibility storage remains active: ${String(error)}`); activeHistory = undefined; }
  const seconds = (key: string, fallback: number): number => {
    const value = config.get<number>(key, fallback);
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
  };
  const positiveInteger = (key: string, fallback: number): number => {
    const value = config.get<number>(key, fallback);
    return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
  };
   const scanner: TaskScannerOptions = {
     enabled: config.get<boolean>("taskScanner.enabled", DEFAULT_TASK_SCANNER_OPTIONS.enabled),
     terminalStabilityMs: seconds("taskScanner.terminalStabilitySeconds", 15) * 1_000,
     interTaskDelayMs: seconds("taskScanner.interTaskDelaySeconds", 15) * 1_000,
     detectIncompleteCompletions: config.get<boolean>("taskScanner.detectIncompleteCompletions", DEFAULT_TASK_SCANNER_OPTIONS.detectIncompleteCompletions),
     maxUnchangedCompletionCorrectionRounds: positiveInteger("taskScanner.maxUnchangedCompletionCorrectionRounds", DEFAULT_TASK_SCANNER_OPTIONS.maxUnchangedCompletionCorrectionRounds),
     detectTestTimeouts: config.get<boolean>("taskScanner.detectTestTimeouts", DEFAULT_TASK_SCANNER_OPTIONS.detectTestTimeouts),
     implementAuditRecommendations: config.get<boolean>("taskScanner.implementAuditRecommendations", DEFAULT_TASK_SCANNER_OPTIONS.implementAuditRecommendations),
     requirePostImplementationReport: config.get<boolean>("taskScanner.requirePostImplementationReport", DEFAULT_TASK_SCANNER_OPTIONS.requirePostImplementationReport),
     verifyCompletionCriteria: config.get<boolean>("taskScanner.verifyCompletionCriteria", DEFAULT_TASK_SCANNER_OPTIONS.verifyCompletionCriteria),
     completionConfidenceThreshold: Math.min(100, positiveInteger("taskScanner.completionConfidenceThreshold", DEFAULT_TASK_SCANNER_OPTIONS.completionConfidenceThreshold)),
     maxCompletionVerificationRounds: positiveInteger("taskScanner.maxCompletionVerificationRounds", DEFAULT_TASK_SCANNER_OPTIONS.maxCompletionVerificationRounds),
     reflective: scannerConfig.get<boolean>("taskScanner.reflective", DEFAULT_TASK_SCANNER_OPTIONS.reflective),
     restartOnYoloFailure: config.get<boolean>("taskScanner.restartOnYoloFailure", DEFAULT_TASK_SCANNER_OPTIONS.restartOnYoloFailure),
     detectStuckLoops: config.get<boolean>("taskScanner.detectStuckLoops", DEFAULT_TASK_SCANNER_OPTIONS.detectStuckLoops),
     maxStuckLoopRounds: positiveInteger("taskScanner.maxStuckLoopRounds", DEFAULT_TASK_SCANNER_OPTIONS.maxStuckLoopRounds),
     waitForLmStudio: config.get<boolean>("taskScanner.waitForLmStudio", DEFAULT_TASK_SCANNER_OPTIONS.waitForLmStudio),
     lmStudioHost: config.get<string>("taskScanner.lmStudioHost", DEFAULT_TASK_SCANNER_OPTIONS.lmStudioHost),
     lmStudioPort: positiveInteger("taskScanner.lmStudioPort", DEFAULT_TASK_SCANNER_OPTIONS.lmStudioPort),
     singleQueuePerLmStudioModel: config.get<boolean>("taskScanner.singleQueuePerLmStudioModel", DEFAULT_TASK_SCANNER_OPTIONS.singleQueuePerLmStudioModel)
   };
  const busyTerminals = new Set<vscode.Terminal>();
  const taskTerminals = new Set<vscode.Terminal>();
  const taskDocumentUris = new Set<string>();
  const sudoPromptedAt = new WeakMap<vscode.Terminal, number>();
  context.subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution(event => {
      busyTerminals.add(event.terminal);
      taskTerminals.add(event.terminal);
      const sudoPromptEnabled = vscode.workspace.getConfiguration("cline-console", vscode.Uri.file(workspace)).get<boolean>("taskScanner.sudoZenityPrompt", true);
      const commandLine = event.execution.commandLine.value;
      const lastPromptedAt = sudoPromptedAt.get(event.terminal) ?? 0;
      if (sudoPromptEnabled && activeQueue?.getStatus().running && containsInteractiveSudo(commandLine) && Date.now() - lastPromptedAt >= 30_000) {
        sudoPromptedAt.set(event.terminal, Date.now());
        showSudoZenityPrompt(workspace, () => { void vscode.window.showWarningMessage("Cline requires sudo authentication. Enter the password in the VS Code terminal."); });
        logger.info(`Displayed sudo authentication prompt for a queued task in ${workspace}.`);
      }
    }),
    vscode.window.onDidEndTerminalShellExecution(event => busyTerminals.delete(event.terminal)),
    vscode.window.onDidCloseTerminal(terminal => {
      busyTerminals.delete(terminal);
      taskTerminals.delete(terminal);
    }),
    vscode.workspace.onDidOpenTextDocument(document => {
      if (document.uri.scheme === "file") taskDocumentUris.add(document.uri.fsPath);
    })
  );
  const cleanupTerminals = async (): Promise<void> => {
    if (!vscode.workspace.getConfiguration("cline-console", vscode.Uri.file(workspace)).get<boolean>("taskScanner.cleanupTerminals", true)) return;
    // A multi-root window does not provide reliable per-terminal ownership.
    if (vscode.workspace.workspaceFolders?.length !== 1) return;
    const result = await cleanupTaskTerminalsWithRetries(() => vscode.window.terminals, workspace, undefined,
      terminal => busyTerminals.has(terminal as vscode.Terminal)
        || (vscode.window.activeTerminal === terminal && !taskTerminals.has(terminal as vscode.Terminal)));
    logger.info(`Task terminal cleanup disposed ${result.closed} idle workspace terminal(s) in ${workspace} across ${result.passes} pass(es).`);
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs.flatMap(tab => {
      const uris = tab.input instanceof vscode.TabInputText ? [tab.input.uri]
        : tab.input instanceof vscode.TabInputNotebook ? [tab.input.uri]
        : tab.input instanceof vscode.TabInputTextDiff ? [tab.input.original, tab.input.modified] : [];
      const fileUris = uris.filter(uri => uri.scheme === "file");
      if (!fileUris.length) return [];
      const dirty = fileUris.some(uri => vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString())?.isDirty === true);
      return [{ uris: fileUris.map(uri => uri.fsPath), dirty, pinned: tab.isPinned, close: () => vscode.window.tabGroups.close(tab) }];
    }));
    const tabResult = await cleanupTaskTabs(tabs, taskDocumentUris, workspace, true);
    logger.info(`Task tab cleanup closed ${tabResult.closed} clean unpinned workspace tab(s), preserved ${tabResult.preservedDirty} dirty tab(s), and preserved ${tabResult.preservedPinned} pinned tab(s) in ${workspace}.`);
  };
  const runtimeQueueFile = `${directory}/queue-${workspaceId(workspace)}.json`;
  const persistentQueueFile = queueStatePath(workspace);
  if (await migrateRuntimeQueueState(runtimeQueueFile, persistentQueueFile)) {
    logger.info(`Migrated queue state for ${workspace} from runtime storage to ${persistentQueueFile}.`);
  }
  activeQueue = new TaskQueue(
    persistentQueueFile,
    workspace,
    adapter,
    logger,
    activeHistory,
    scanner,
    cleanupTerminals,
    signal => waitForLmStudio(scanner.lmStudioHost, scanner.lmStudioPort, signal, logger),
    () => activeServer?.ownsRegistration() ?? Promise.resolve(false)
  );
  activeServer = new IpcServer(directory, workspace, adapter, logger, activeQueue, activeHistory);
  let queueStarted = false;
  const start = async (): Promise<void> => {
    if (!config.get<boolean>("enabled", true)) return;
    await activeServer!.start();
    if (!queueStarted) {
      await activeQueue!.start();
      queueStarted = true;
    }
  };
  const stop = async (): Promise<void> => {
    await activeQueue?.stop();
    queueStarted = false;
    await activeServer?.stop();
  };
  registerCommands(context, activeServer, adapter, start, stop);
  context.subscriptions.push({ dispose: () => { void stop(); } });
  if (config.get<boolean>("autoStart", true)) await start();
}

export async function deactivate(): Promise<void> { await activeQueue?.stop(); await activeServer?.stop(); activeHistory?.close(); activeQueue = undefined; activeServer = undefined; activeHistory = undefined; }
