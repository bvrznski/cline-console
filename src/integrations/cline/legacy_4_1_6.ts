import * as vscode from "vscode";
import { ClineConsoleError } from "../../common/errors";
import type { Logger } from "../../common/logging";
import { UNAVAILABLE_CAPABILITIES } from "./capabilities";
import { discoverCline } from "./discovery";
import type { ClineAdapter, ClineCapabilities, ClineStatus, TaskResult } from "./types";

interface LegacyPublicApi {
  startNewTask(prompt: string, images?: string[]): Promise<void>;
  showTaskWithId?(taskId: string): Promise<void>;
  sendMessage(message: string, images?: string[]): Promise<void>;
  pressPrimaryButton?(): Promise<void>;
  pressSecondaryButton?(): Promise<void>;
}

function isLegacyPublicApi(value: unknown): value is LegacyPublicApi {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.startNewTask === "function" && typeof candidate.sendMessage === "function";
}

export class LegacyCline416Adapter implements ClineAdapter {
  private api?: LegacyPublicApi;
  private lastState: ClineStatus["state"] = "unknown";
  private task: ClineStatus["task"] = "unknown";
  private observedAt?: string;

  constructor(private readonly logger: Logger) {}

  private async activate(): Promise<LegacyPublicApi> {
    if (this.api) return this.api;
    const extension = discoverCline();
    if (!extension) throw new ClineConsoleError("CLINE_NOT_INSTALLED", "Cline is not installed or is disabled.");
    const exports = await extension.activate();
    if (!isLegacyPublicApi(exports)) throw new ClineConsoleError("CLINE_API_UNSUPPORTED", `Cline ${extension.packageJSON.version ?? "unknown"} does not expose startNewTask/sendMessage.`);
    this.api = exports;
    this.logger.info(`Detected Cline ${String(extension.packageJSON.version)} public task API.`);
    return exports;
  }

  async detect(): Promise<boolean> { try { await this.activate(); return true; } catch { return false; } }
  async getVersion(): Promise<string | undefined> { return discoverCline()?.packageJSON.version as string | undefined; }

  async getCapabilities(): Promise<ClineCapabilities> {
    const extension = discoverCline();
    if (!extension) return { ...UNAVAILABLE_CAPABILITIES };
    try {
      const api = await this.activate();
      return { newTask: true, followup: true, cancel: true, taskStatus: false, taskId: false, directApi: true, commandApi: true, webviewBridge: false,
        ...(api.pressSecondaryButton ? {} : {}) };
    } catch { return { ...UNAVAILABLE_CAPABILITIES, cancel: true, commandApi: true }; }
  }

  async newTask(prompt: string): Promise<TaskResult> {
    if (!prompt.length) throw new ClineConsoleError("EMPTY_PROMPT", "Task prompt must not be empty.");
    const api = await this.activate();
    await this.revealSidebar();
    await api.startNewTask(prompt);
    this.task = "active"; this.lastState = "submitted"; this.observedAt = new Date().toISOString();
    return { taskStarted: true };
  }

  async resumeTask(taskId: string): Promise<TaskResult> {
    if (!taskId.length) throw new ClineConsoleError("TASK_NOT_FOUND", "Historical task ID is required.");
    const api = await this.activate();
    if (!api.showTaskWithId) throw new ClineConsoleError("CLINE_API_UNSUPPORTED", "Cline does not expose native historical task resume. Refusing to start a replacement task.");
    await this.revealSidebar();
    await api.showTaskWithId(taskId);
    this.task = "active"; this.lastState = "waiting"; this.observedAt = new Date().toISOString();
    return { taskStarted: true, taskId };
  }

  private async revealSidebar(): Promise<void> {
    const extension = discoverCline();
    if (!extension) throw new ClineConsoleError("CLINE_NOT_INSTALLED", "Cline is not installed or is disabled.");
    const extensionName = extension.packageJSON.name;
    if (typeof extensionName !== "string" || !extensionName) throw new ClineConsoleError("CLINE_VIEW_UNAVAILABLE", "Cline's sidebar view identifier could not be determined.");
    const containerCommand = `workbench.view.extension.${extensionName}-ActivityBar`;
    const focusCommand = `${extensionName}.SidebarProvider.focus`;
    this.logger.debug(`Revealing Cline sidebar with ${containerCommand}, ${focusCommand}, and cline.focusChatInput.`);
    await vscode.commands.executeCommand("workbench.action.focusSideBar");
    await vscode.commands.executeCommand(containerCommand);
    await vscode.commands.executeCommand(focusCommand);
    await vscode.commands.executeCommand("cline.focusChatInput");
  }

  async sendMessage(message: string): Promise<void> {
    if (!message.length) throw new ClineConsoleError("EMPTY_MESSAGE", "Follow-up message must not be empty.");
    await (await this.activate()).sendMessage(message);
    this.task = "active"; this.lastState = "submitted"; this.observedAt = new Date().toISOString();
  }

  async cancelTask(): Promise<void> {
    const extension = discoverCline();
    if (!extension) throw new ClineConsoleError("CLINE_NOT_INSTALLED", "Cline is not installed or is disabled.");
    await extension.activate();
    await vscode.commands.executeCommand("cline.plusButtonClicked");
    this.task = "none"; this.lastState = "cancelled"; this.observedAt = new Date().toISOString();
  }

  async getStatus(): Promise<ClineStatus> {
    const connected = await this.detect();
    return { connected, version: await this.getVersion(), task: this.task, state: this.lastState, observedAt: this.observedAt,
      detail: "Task status is local bridge state; Cline Legacy does not export authoritative status or task IDs." };
  }
}
