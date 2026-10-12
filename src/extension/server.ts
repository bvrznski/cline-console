import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { ClineConsoleError, errorMessage } from "../common/errors";
import type { Logger } from "../common/logging";
import { MAX_MESSAGE_BYTES, MAX_MESSAGE_MIB, parseRequest, serializeResponse } from "../ipc/protocol";
import type { IpcRequest, IpcResponse, QueueStatus, WorkspaceRegistration } from "../ipc/types";
import type { ClineAdapter } from "../integrations/cline/types";
import type { TaskQueue } from "./task_queue";
import { getLatestLegacyWorkspaceTaskPrompt, getLegacyWorkspaceActivity, getLegacyWorkspaceSessionStatus, reconcileLegacyStatus } from "../integrations/cline/completion_monitor";
import { deleteLegacyQueuedTaskHistory, getLegacyUnfinishedWorkspaceTasks } from "../integrations/cline/task_history";
import { attachTokenUsage } from "../integrations/cline/token_usage";
import { TaskModelIdentityCache } from "./lmstudio_ready";
import { ensureRuntimeDirectory, ownsWorkspaceRegistration, registerWorkspace, socketPath, unregisterWorkspace, workspaceId } from "./workspace_registry";
import type { HistoryStore } from "../history/history_store";

export class IpcServer {
  private server?: net.Server;
  private registration?: WorkspaceRegistration;
  private queueStatusRefresh?: Promise<QueueStatus>;
  private queueStatusCache?: { at: number; value: QueueStatus };
  private readonly taskModelIdentity = new TaskModelIdentityCache();

  constructor(private readonly directory: string, private readonly workspace: string, private readonly adapter: ClineAdapter, private readonly logger: Logger, private readonly queue?: TaskQueue, private readonly history?: HistoryStore) {}

  async start(): Promise<WorkspaceRegistration> {
    if (this.server && this.registration) return this.registration;
    await ensureRuntimeDirectory(this.directory);
    const canonicalWorkspace = await fs.realpath(this.workspace);
    const targetSocket = socketPath(this.directory, workspaceId(canonicalWorkspace));
    await this.removeStaleSocket(targetSocket);
    this.registration = await registerWorkspace(this.directory, canonicalWorkspace);
    try {
      this.server = net.createServer(socket => this.handleConnection(socket));
      this.server.on("error", error => this.logger.error(`IPC server error: ${errorMessage(error)}`));
      await new Promise<void>((resolve, reject) => this.server!.listen(this.registration!.socketPath, () => resolve()).once("error", reject));
      await fs.chmod(this.registration.socketPath, 0o600);
    } catch (error) {
      await unregisterWorkspace(this.directory, this.registration);
      this.registration = undefined;
      throw error;
    }
    this.logger.info(`Listening on ${this.registration.socketPath}`);
    return this.registration;
  }

  private async removeStaleSocket(target: string): Promise<void> {
    try {
      const stat = await fs.lstat(target);
      if (!stat.isSocket()) throw new ClineConsoleError("UNSAFE_SOCKET_PATH", `Refusing to replace non-socket path: ${target}`);
      if (await socketAcceptsConnections(target)) throw new ClineConsoleError("WORKSPACE_ALREADY_REGISTERED", `A live Cline Console server already owns ${target}.`);
      await fs.unlink(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private handleConnection(socket: net.Socket): void {
    socket.setTimeout(30_000, () => socket.destroy());
    let data = Buffer.alloc(0), handled = false;
    socket.on("data", chunk => {
      if (handled) return;
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_MESSAGE_BYTES) { handled = true; this.writeError(socket, "unknown", new ClineConsoleError("REQUEST_TOO_LARGE", `IPC request exceeds ${MAX_MESSAGE_MIB} MiB.`)); return; }
      const newline = data.indexOf(10);
      if (newline < 0) return;
      handled = true;
      this.process(socket, data.subarray(0, newline).toString("utf8")).catch(error => this.writeError(socket, "unknown", error));
    });
    socket.on("error", error => this.logger.debug(`Client connection ended: ${errorMessage(error)}`));
  }

  private async process(socket: net.Socket, line: string): Promise<void> {
    let request: IpcRequest;
    try { request = parseRequest(line); } catch (error) { this.writeError(socket, "unknown", error); return; }
    try {
      const expected = await fs.realpath(this.workspace);
      const requested = await fs.realpath(path.resolve(request.workspace));
      if (requested !== expected) throw new ClineConsoleError("WORKSPACE_MISMATCH", "Request workspace does not match this VS Code window.");
      const requestLog = `Received ${request.action} request ${request.requestId}.`;
      if (isPollingAction(request.action)) this.logger.debug(requestLog);
      else this.logger.info(requestLog);
      if (!isPollingAction(request.action)) this.recordHistory(() => this.history!.recordEvent(expected, { type: "ipc_request", source: "cli", payload: summarizeRequest(request) }));
      if (!isReadOnlyAction(request.action)) this.queueStatusCache = undefined;
      let result: unknown;
      switch (request.action) {
        case "newTask": {
          const prompt = requiredText(request.payload?.prompt, "prompt");
          const previous = await getLatestLegacyWorkspaceTaskPrompt(expected);
          result = await this.adapter.newTask(prompt);
          let clineSessionId = (result as { taskId?: string }).taskId;
          if (!clineSessionId) clineSessionId = await awaitStartedSession(expected, prompt, previous?.sessionId);
          if (clineSessionId && this.queue) await this.queue.registerOwnedSession(clineSessionId);
          this.recordHistory(() => this.history!.recordTask(expected, clineSessionId ?? request.requestId, prompt, "<inline-or-stdin>", "task", { requestId: request.requestId, clineSessionId }));
          break;
        }
        case "reloadTask": {
          const latest = await getLatestLegacyWorkspaceTaskPrompt(expected);
          if (!latest || !this.queue?.ownsSession(latest.sessionId)) throw new ClineConsoleError("TASK_NOT_OWNED", "The latest Cline task was not created by cline-console.");
          await this.adapter.newTask(latest.prompt);
          const reloadedSessionId = await awaitStartedSession(expected, latest.prompt, latest.sessionId);
          if (reloadedSessionId) await this.queue.adoptReloadedSession(latest.sessionId, reloadedSessionId, latest.prompt);
          result = { taskReloaded: true, previousTaskId: latest.sessionId };
          break;
        }
        case "resumeHistoryTask": {
          const sessionId = requiredText(request.payload?.sessionId, "sessionId");
          if (!this.queue?.ownsSession(sessionId)) throw new ClineConsoleError("TASK_NOT_OWNED", "Refusing to resume a Cline task not created by cline-console.");
          await this.queue.sendOwnedMessage(sessionId, "Complete all unfinished work in this existing task. Validate the full original scope before completing.", "historical-task continuation");
          result = { taskResumed: true, sessionId };
          break;
        }
        case "resumePreemptedQueueTask": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          result = await this.queue.resumeAfterModelConflict(requiredText(request.payload?.sessionId, "sessionId"), requiredText(request.payload?.modelIdentity, "modelIdentity"));
          break;
        }
        case "finishUnfinishedTasks": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          const unfinished = (await getLegacyUnfinishedWorkspaceTasks(expected)).filter(task => this.queue!.ownsSession(task.sessionId));
          const activity = await getLegacyWorkspaceActivity(expected);
          if (activity.status === "waiting" && activity.sessionId && unfinished.some(task => task.sessionId === activity.sessionId)) await this.queue.skipWaitingTask(activity.sessionId);
          result = { discovered: unfinished.length, ...await this.queue.enqueueUnfinished(unfinished) };
          break;
        }
        case "confirmCompletion": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          result = await this.queue.confirmCompletion();
          break;
        }
        case "skipWaitingTask": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          result = await this.queue.skipWaitingTask(requiredText(request.payload?.sessionId, "sessionId"));
          break;
        }
        case "sendMessage": {
          const activity = await getLegacyWorkspaceActivity(expected);
          if (!this.queue?.ownsSession(activity.sessionId)) throw new ClineConsoleError("TASK_NOT_OWNED", "Refusing to message a Cline task not created by cline-console.");
          await this.queue.sendOwnedMessage(activity.sessionId!, requiredText(request.payload?.message, "message")); result = { messageSent: true }; break;
        }
        case "cancelTask": {
          const activity = await getLegacyWorkspaceActivity(expected);
          if (!this.queue?.ownsSession(activity.sessionId)) throw new ClineConsoleError("TASK_NOT_OWNED", "Refusing to cancel a Cline task not created by cline-console.");
          await this.adapter.cancelTask(); result = { taskCancelled: true }; break;
        }
        case "preemptQueueTask": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          const sessionId = requiredText(request.payload?.sessionId, "sessionId");
          const winnerWorkspace = requiredText(request.payload?.winnerWorkspace, "winnerWorkspace");
          const modelIdentity = requiredText(request.payload?.modelIdentity, "modelIdentity");
          const activity = await getLegacyWorkspaceActivity(expected);
          if (activity.status !== "running" || activity.sessionId !== sessionId || !this.queue.ownsSession(sessionId)) throw new ClineConsoleError("TASK_NOT_OWNED", "Refusing to preempt a task that is not the exact running cline-console queue session.");
          await this.queue.pauseForModelConflict(sessionId, winnerWorkspace, modelIdentity);
          await this.adapter.interruptTask();
          result = { taskInterrupted: true, queuePaused: true };
          break;
        }
        case "status": {
          const session = await getLegacyWorkspaceSessionStatus(expected);
          const bridgeStatus = await this.adapter.getStatus();
          result = this.queue?.ownsSession(session?.sessionId)
            ? reconcileLegacyStatus(bridgeStatus, session)
            : { ...bridgeStatus, task: "none", state: "idle", taskId: undefined, title: undefined, sourcePath: undefined, detail: "No cline-console-owned task is running in this workspace." };
          const latest = await getLatestLegacyWorkspaceTaskPrompt(expected);
          if (this.queue && latest && latest.sessionId === (result as { taskId?: string }).taskId) {
            const sourcePath = this.queue.sourcePathForPrompt(latest.prompt);
            if (sourcePath) result = { ...(result as object), sourcePath };
          }
          break;
        }
        case "capabilities": result = { version: await this.adapter.getVersion(), capabilities: await this.adapter.getCapabilities() }; break;
        case "enqueueTasks": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          const tasks = request.payload?.tasks;
          const force = request.payload?.force === true;
          if (!Array.isArray(tasks) || !tasks.length || (request.payload?.allowDuplicates !== undefined && typeof request.payload.allowDuplicates !== "boolean") || (request.payload?.freshOnInterrupted !== undefined && typeof request.payload.freshOnInterrupted !== "boolean") || tasks.some(task => typeof task.sourcePath !== "string" || typeof task.prompt !== "string" || !task.prompt.length || (task.reflective !== undefined && typeof task.reflective !== "boolean") || (task.scopePath !== undefined && typeof task.scopePath !== "string"))) {
            throw new ClineConsoleError("INVALID_PAYLOAD", "tasks must be a non-empty array of sourcePath/prompt values.");
          }
          const activity = force ? await getLegacyWorkspaceActivity(expected) : request.payload?.freshOnInterrupted === true ? await getLegacyWorkspaceActivity(expected) : undefined;
          result = await this.queue.enqueue(tasks, request.payload?.allowDuplicates === true || force, request.payload?.freshOnInterrupted === true && activity?.status !== "running", force);
          break;
        }
        case "enqueueMessages": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          const messages = request.payload?.messages;
          if (!Array.isArray(messages) || !messages.length || messages.some(message => typeof message.sourcePath !== "string" || typeof message.message !== "string" || !message.message.length || typeof message.sessionId !== "string" || !message.sessionId.length)) {
            throw new ClineConsoleError("INVALID_PAYLOAD", "messages must be a non-empty array of sourcePath/message/sessionId values.");
          }
          if (messages.some(message => !this.queue!.ownsSession(message.sessionId))) throw new ClineConsoleError("TASK_NOT_OWNED", "Refusing to queue messages for a Cline task not created by cline-console.");
          result = await this.queue.enqueueMessages(messages);
          break;
        }
        case "replaceQueue": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          const tasks = request.payload?.tasks;
          if (!Array.isArray(tasks) || !tasks.length || tasks.some(task => typeof task.sourcePath !== "string" || typeof task.prompt !== "string" || !task.prompt.length || (task.reflective !== undefined && typeof task.reflective !== "boolean") || (task.scopePath !== undefined && typeof task.scopePath !== "string"))) {
            throw new ClineConsoleError("INVALID_PAYLOAD", "tasks must be a non-empty array of sourcePath/prompt values.");
          }
          result = await this.queue.replace(tasks);
          break;
        }
        case "clearQueue": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          const clearHistory = request.payload?.force === true ? async (selectors: { prompts: string[]; taskIds: string[] }) => {
            const latest = await getLatestLegacyWorkspaceTaskPrompt(expected);
            if (latest && (selectors.taskIds.includes(latest.sessionId) || selectors.prompts.includes(latest.prompt))) await this.adapter.cancelTask();
            return (await deleteLegacyQueuedTaskHistory(expected, selectors.prompts, selectors.taskIds)).deleted;
          } : undefined;
          result = await this.queue.clear(clearHistory);
          break;
        }
        case "clearWorkspace": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          result = await this.queue.clear();
          break;
        }
        case "popQueue": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          result = await this.queue.pop(requiredText(request.payload?.selector, "selector"), request.payload?.resolvedSelector, request.payload?.selectorType);
          break;
        }
        case "trimQueue": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          result = await this.queue.trim(requiredPositiveInteger(request.payload?.keep, "keep"));
          break;
        }
        case "pauseQueue": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          result = await this.queue.pause();
          break;
        }
        case "resumeQueue": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          result = await this.queue.resume();
          break;
        }
        case "continueQueue": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          result = await this.queue.continueCurrent();
          break;
        }
        case "relaunchQueue": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          result = await this.queue.relaunchCurrent();
          break;
        }
        case "queueStatus": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          result = await this.getQueueStatus(expected);
          break;
        }
        case "enqueueContext": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          result = this.queue.getEnqueueContext();
          break;
        }
        case "activity": {
          const activity = await this.queue?.currentOwnedActivity() ?? await getLegacyWorkspaceActivity(expected);
          const modelConflict = this.queue?.modelConflict();
          const queueActive = this.queue?.getEnqueueContext().active === true;
          if (!this.queue?.ownsSession(activity.sessionId)) {
            this.taskModelIdentity.clear();
            result = { active: false, queueActive, status: "idle", ...(modelConflict ? { sessionId: modelConflict.sessionId, modelConflict } : {}) };
          }
          else {
            const arbitration = this.queue.lmStudioArbitration();
            if (activity.status !== "running" || !arbitration.enabled || !activity.sessionId) this.taskModelIdentity.clear();
            const modelIdentity = activity.status === "running" && arbitration.enabled && activity.sessionId
              ? await this.taskModelIdentity.get(activity.sessionId, arbitration.host, arbitration.port)
              : undefined;
            result = { ...activity, queueActive, ...(modelIdentity ? { modelIdentity } : {}), ...(modelConflict ? { modelConflict } : {}) };
          }
          break;
        }
        case "ping": {
          // Simple ping handler to verify extension is responsive
          result = { pong: true, timestamp: Date.now() };
          break;
        }
      }
      if (!isPollingAction(request.action)) this.recordHistory(() => this.history!.recordEvent(expected, { type: "ipc_response", source: "cline-console", payload: summarizeResponse(request, result) }));
      this.write(socket, { protocolVersion: 1, requestId: request.requestId, ok: true, result });
    } catch (error) {
      this.recordHistory(() => this.history!.recordEvent(this.workspace, { type: "ipc_error", source: "cline-console", payload: { requestId: request.requestId, action: request.action, error: errorMessage(error) } }));
      this.writeError(socket, request.requestId, error);
    }
  }

  private write(socket: net.Socket, response: IpcResponse): void { socket.end(serializeResponse(response)); }

  private async getQueueStatus(workspace: string): Promise<QueueStatus> {
    if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
    if (this.queueStatusCache && Date.now() - this.queueStatusCache.at < 5_000) return this.queueStatusCache.value;
    if (this.queueStatusRefresh) return this.queueStatusRefresh;
    this.queueStatusRefresh = (async () => {
      const ownedSessionIds = this.queue!.ownedSessionIds();
      // queueStatus is the hot path used by --watch. It must remain a passive
      // projection of already-owned state: querying Cline here causes its
      // Legacy UI to rebuild large task presentations on every poll and can
      // starve the queue worker. The worker is the sole authority that observes
      // Cline activity and refreshes retained telemetry.
      void workspace;
      const value = attachTokenUsage(this.queue!.getStatus(), this.queue!.getRetainedTokenUsage(), ownedSessionIds);
      this.queueStatusCache = { at: Date.now(), value };
      return value;
    })();
    try { return await this.queueStatusRefresh; }
    finally { this.queueStatusRefresh = undefined; }
  }
  private recordHistory(operation: () => void): void {
    if (!this.history) return;
    try { operation(); } catch (error) { this.logger.error(`Failed to record SQLite history event: ${errorMessage(error)}`); }
  }
  private writeError(socket: net.Socket, requestId: string, error: unknown): void {
    const code = error instanceof ClineConsoleError ? error.code : "INTERNAL_ERROR";
    this.logger.error(`${code}: ${errorMessage(error)}`);
    this.write(socket, { protocolVersion: 1, requestId, ok: false, error: { code, message: errorMessage(error) } });
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    if (this.registration) await unregisterWorkspace(this.directory, this.registration);
    this.server = undefined; this.registration = undefined;
  }

  get socketPath(): string | undefined { return this.registration?.socketPath; }

  async ownsRegistration(): Promise<boolean> {
    return this.registration !== undefined && await ownsWorkspaceRegistration(this.directory, this.registration);
  }
}

const POLLING_ACTIONS = new Set<IpcRequest["action"]>(["ping", "activity", "status", "queueStatus", "enqueueContext"]);
const READ_ONLY_ACTIONS = new Set<IpcRequest["action"]>([...POLLING_ACTIONS, "capabilities"]);

export function isPollingAction(action: IpcRequest["action"]): boolean { return POLLING_ACTIONS.has(action); }
function isReadOnlyAction(action: IpcRequest["action"]): boolean { return READ_ONLY_ACTIONS.has(action); }

export function summarizeRequest(request: IpcRequest): Record<string, unknown> {
  const tasks = Array.isArray(request.payload?.tasks) ? request.payload!.tasks as unknown[] : undefined;
  const messages = Array.isArray(request.payload?.messages) ? request.payload!.messages as unknown[] : undefined;
  return {
    requestId: request.requestId,
    action: request.action,
    ...(tasks ? { taskCount: tasks.length } : {}),
    ...(messages ? { messageCount: messages.length } : {}),
    payloadKeys: request.payload ? Object.keys(request.payload).sort() : []
  };
}

export function summarizeResponse(request: IpcRequest, result: unknown): Record<string, unknown> {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
  return {
    requestId: request.requestId,
    action: request.action,
    resultType: Array.isArray(result) ? "array" : typeof result,
    ...(record && typeof record.queueLength === "number" ? { queueLength: record.queueLength } : {}),
    ...(record && typeof record.taskId === "string" ? { taskId: record.taskId } : {})
  };
}

async function awaitStartedSession(workspace: string, prompt: string, previousSessionId?: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const latest = await getLatestLegacyWorkspaceTaskPrompt(workspace);
    if (latest?.prompt === prompt && latest.sessionId !== previousSessionId) return latest.sessionId;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return undefined;
}

async function socketAcceptsConnections(target: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createConnection(target);
    const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 500);
    probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(true); });
    probe.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ClineConsoleError("INVALID_PAYLOAD", `${name} must be a non-empty string.`);
  return value;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new ClineConsoleError("INVALID_PAYLOAD", `${name} must be a positive integer.`);
  return value as number;
}
