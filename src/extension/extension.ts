import * as vscode from "vscode";
import { promises as fs } from "node:fs";
import { combineLoggers, fileLogger, type Logger, type LogLevel } from "../common/logging";
import { createClineAdapter } from "../integrations/cline/adapter";
import { registerCommands } from "./commands";
import { IpcServer } from "./server";
import { runtimeDirectory } from "./workspace_registry";
import { workspaceId } from "./workspace_registry";
import { TaskQueue } from "./task_queue";
import { HistoryStore } from "../history/history_store";

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
  const directory = runtimeDirectory(config.get<string>("socketDirectory", ""));
  const adapter = createClineAdapter(logger);
  try {
    activeHistory = new HistoryStore();
    activeHistory.registerWorkspace(workspace, { vscodeVersion: vscode.version, extensionVersion: context.extension.packageJSON.version, nodeVersion: process.version, platform: process.platform, architecture: process.arch });
    activeHistory.recordPromptSnapshot(workspace, "system_prompt", undefined, "cline-runtime-private", await adapter.getVersion(), undefined, { availability: "not_exposed_by_public_api", clineConsolePolicy: "capture_full_content_when_observable" });
  } catch (error) { logger.error(`SQLite history is unavailable; queue compatibility storage remains active: ${String(error)}`); activeHistory = undefined; }
  activeQueue = new TaskQueue(`${directory}/queue-${workspaceId(workspace)}.json`, workspace, adapter, logger, activeHistory);
  await activeQueue.start();
  activeServer = new IpcServer(directory, workspace, adapter, logger, activeQueue, activeHistory);
  const start = async (): Promise<void> => { if (config.get<boolean>("enabled", true)) await activeServer!.start(); };
  const stop = async (): Promise<void> => { await activeQueue?.stop(); await activeServer?.stop(); };
  registerCommands(context, activeServer, adapter, start, stop);
  context.subscriptions.push({ dispose: () => { void stop(); } });
  if (config.get<boolean>("autoStart", true)) await start();
}

export async function deactivate(): Promise<void> { await activeQueue?.stop(); await activeServer?.stop(); activeHistory?.close(); activeQueue = undefined; activeServer = undefined; activeHistory = undefined; }
