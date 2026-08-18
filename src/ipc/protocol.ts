import { randomUUID } from "node:crypto";
import { ClineConsoleError } from "../common/errors";
import { PROTOCOL_VERSION } from "../common/version";
import type { Action, IpcRequest, IpcResponse } from "./types";

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export function makeRequest(action: Action, workspace: string, payload?: IpcRequest["payload"]): IpcRequest {
  return { protocolVersion: PROTOCOL_VERSION, requestId: randomUUID(), action, workspace, payload };
}

export function parseRequest(line: string): IpcRequest {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new ClineConsoleError("MALFORMED_JSON", "Request is not valid JSON."); }
  if (!value || typeof value !== "object") throw new ClineConsoleError("INVALID_REQUEST", "Request must be an object.");
  const request = value as Partial<IpcRequest>;
  if (request.protocolVersion !== PROTOCOL_VERSION) throw new ClineConsoleError("PROTOCOL_MISMATCH", `Protocol version ${String(request.protocolVersion)} is unsupported.`);
  if (typeof request.requestId !== "string" || !request.requestId) throw new ClineConsoleError("INVALID_REQUEST", "requestId is required.");
  if (!(["newTask", "reloadTask", "finishUnfinishedTasks", "skipWaitingTask", "sendMessage", "cancelTask", "status", "capabilities", "enqueueTasks", "enqueueMessages", "replaceQueue", "clearQueue", "clearWorkspace", "popQueue", "pauseQueue", "resumeQueue", "queueStatus", "activity"] as unknown[]).includes(request.action)) throw new ClineConsoleError("INVALID_ACTION", "Unknown action.");
  if (typeof request.workspace !== "string" || !request.workspace) throw new ClineConsoleError("INVALID_WORKSPACE", "workspace is required.");
  return request as IpcRequest;
}

export function serializeResponse(response: IpcResponse): string { return `${JSON.stringify(response)}\n`; }
