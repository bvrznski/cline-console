import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { ClineConsoleError, errorMessage } from "../common/errors";
import type { Logger } from "../common/logging";
import { MAX_MESSAGE_BYTES, parseRequest, serializeResponse } from "../ipc/protocol";
import type { IpcRequest, IpcResponse, WorkspaceRegistration } from "../ipc/types";
import type { ClineAdapter } from "../integrations/cline/types";
import type { TaskQueue } from "./task_queue";
import { getLegacyWorkspaceActivity, getLegacyWorkspaceSessionStatus, reconcileLegacyStatus } from "../integrations/cline/completion_monitor";
import { ensureRuntimeDirectory, registerWorkspace, socketPath, unregisterWorkspace, workspaceId } from "./workspace_registry";

export class IpcServer {
  private server?: net.Server;
  private registration?: WorkspaceRegistration;

  constructor(private readonly directory: string, private readonly workspace: string, private readonly adapter: ClineAdapter, private readonly logger: Logger, private readonly queue?: TaskQueue) {}

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
      if (data.length > MAX_MESSAGE_BYTES) { handled = true; this.writeError(socket, "unknown", new ClineConsoleError("REQUEST_TOO_LARGE", "IPC request exceeds 8 MiB.")); return; }
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
      this.logger.info(`Received ${request.action} request ${request.requestId}.`);
      let result: unknown;
      switch (request.action) {
        case "newTask": result = await this.adapter.newTask(requiredText(request.payload?.prompt, "prompt")); break;
        case "sendMessage": await this.adapter.sendMessage(requiredText(request.payload?.message, "message")); result = { messageSent: true }; break;
        case "cancelTask": await this.adapter.cancelTask(); result = { taskCancelled: true }; break;
        case "status": result = reconcileLegacyStatus(await this.adapter.getStatus(), await getLegacyWorkspaceSessionStatus(expected)); break;
        case "capabilities": result = { version: await this.adapter.getVersion(), capabilities: await this.adapter.getCapabilities() }; break;
        case "enqueueTasks": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          const tasks = request.payload?.tasks;
          if (!Array.isArray(tasks) || !tasks.length || tasks.some(task => typeof task.sourcePath !== "string" || typeof task.prompt !== "string" || !task.prompt.length)) {
            throw new ClineConsoleError("INVALID_PAYLOAD", "tasks must be a non-empty array of sourcePath/prompt values.");
          }
          result = await this.queue.enqueue(tasks);
          break;
        }
        case "enqueueMessages": {
          if (!this.queue) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Task queue is unavailable.");
          const messages = request.payload?.messages;
          if (!Array.isArray(messages) || !messages.length || messages.some(message => typeof message.sourcePath !== "string" || typeof message.message !== "string" || !message.message.length || typeof message.sessionId !== "string" || !message.sessionId.length)) {
            throw new ClineConsoleError("INVALID_PAYLOAD", "messages must be a non-empty array of sourcePath/message/sessionId values.");
          }
          result = await this.queue.enqueueMessages(messages);
          break;
        }
        case "activity": result = await getLegacyWorkspaceActivity(expected); break;
      }
      this.write(socket, { protocolVersion: 1, requestId: request.requestId, ok: true, result });
    } catch (error) { this.writeError(socket, request.requestId, error); }
  }

  private write(socket: net.Socket, response: IpcResponse): void { socket.end(serializeResponse(response)); }
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
