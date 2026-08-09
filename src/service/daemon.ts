import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { ClineConsoleError, errorMessage } from "../common/errors";
import type { Logger } from "../common/logging";
import { MAX_MESSAGE_BYTES, parseRequest, serializeResponse } from "../ipc/protocol";
import { requestOverSocket } from "../ipc/transport";
import type { IpcResponse } from "../ipc/types";
import { loadRegistrations, resolveWorkspace } from "../client/ipc_client";
import { ensureRuntimeDirectory, runtimeDirectory } from "../extension/workspace_registry";
import { getLegacyWorkspaceActivity, getLegacyWorkspaceSessionStatus, reconcileLegacyStatus } from "../integrations/cline/completion_monitor";
import type { ClineStatus } from "../integrations/cline/types";

export function serviceSocketPath(directory = runtimeDirectory()): string { return path.join(directory, "service.sock"); }

export class ClineConsoleService {
  private server?: net.Server;
  readonly socketPath: string;
  private readonly directory: string;

  constructor(private readonly logger: Logger, directory = runtimeDirectory()) { this.directory = directory; this.socketPath = serviceSocketPath(directory); }

  async start(): Promise<void> {
    await ensureRuntimeDirectory(path.dirname(this.socketPath));
    await this.removeStaleSocket();
    this.server = net.createServer(socket => this.handle(socket));
    this.server.on("error", error => this.logger.error(`Service error: ${errorMessage(error)}`));
    try {
      await new Promise<void>((resolve, reject) => this.server!.listen(this.socketPath, resolve).once("error", reject));
      await fs.chmod(this.socketPath, 0o600);
      this.logger.info(`Singleton service listening on ${this.socketPath} (pid ${process.pid}).`);
    } catch (error) {
      this.server = undefined;
      throw error;
    }
  }

  private async removeStaleSocket(): Promise<void> {
    try {
      const stat = await fs.lstat(this.socketPath);
      if (!stat.isSocket()) throw new ClineConsoleError("UNSAFE_SERVICE_PATH", `Refusing to replace non-socket path: ${this.socketPath}`);
      if (await probeService(this.socketPath)) throw new ClineConsoleError("SERVICE_ALREADY_RUNNING", "A cline-console service instance is already running.");
      await fs.unlink(this.socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private handle(socket: net.Socket): void {
    socket.setTimeout(30_000, () => socket.destroy());
    let data = Buffer.alloc(0), handled = false;
    socket.on("data", chunk => {
      if (handled) return;
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_MESSAGE_BYTES) { handled = true; this.writeError(socket, "unknown", new ClineConsoleError("REQUEST_TOO_LARGE", "Service request exceeds 8 MiB.")); return; }
      const newline = data.indexOf(10);
      if (newline < 0) return;
      handled = true;
      this.route(socket, data.subarray(0, newline).toString("utf8")).catch(error => this.writeError(socket, "unknown", error));
    });
    socket.on("error", error => this.logger.debug(`Service client disconnected: ${errorMessage(error)}`));
  }

  private async route(socket: net.Socket, line: string): Promise<void> {
    let request;
    try { request = parseRequest(line); } catch (error) { this.writeError(socket, "unknown", error); return; }
    try {
      const registration = await resolveWorkspace(await loadRegistrations(this.directory), request.workspace, request.workspace);
      this.logger.info(`Routing ${request.action} request ${request.requestId} to ${registration.workspace}.`);
      if (request.action === "activity") {
        const result = await getLegacyWorkspaceActivity(registration.workspace);
        socket.end(serializeResponse({ protocolVersion: 1, requestId: request.requestId, ok: true, result }));
        return;
      }
      const response = await requestOverSocket(registration.socketPath, request, 30_000);
      if (request.action === "status" && response.ok) {
        response.result = reconcileLegacyStatus(response.result as ClineStatus, await getLegacyWorkspaceSessionStatus(registration.workspace));
      }
      socket.end(serializeResponse(response));
    } catch (error) { this.writeError(socket, request.requestId, error); }
  }

  private writeError(socket: net.Socket, requestId: string, error: unknown): void {
    const code = error instanceof ClineConsoleError ? error.code : "SERVICE_ERROR";
    const response: IpcResponse = { protocolVersion: 1, requestId, ok: false, error: { code, message: errorMessage(error) } };
    this.logger.error(`${code}: ${errorMessage(error)}`);
    socket.end(serializeResponse(response));
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()));
    await fs.unlink(this.socketPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    this.server = undefined;
    this.logger.info("Singleton service stopped.");
  }
}

export async function probeService(socketPath = serviceSocketPath(), timeoutMs = 750): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}
