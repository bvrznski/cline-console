import { randomUUID } from "node:crypto";
import { ClineConsoleError } from "../common/errors";
import { PROTOCOL_VERSION } from "../common/version";
import type { Action, IpcRequest, IpcResponse } from "./types";

export const DEFAULT_IPC_REQUEST_TIMEOUT_MS = 30_000;
export const QUEUE_MUTATION_TIMEOUT_MS = 10 * 60_000;
const LONG_QUEUE_ACTIONS = new Set<Action>(["enqueueTasks", "enqueueMessages", "replaceQueue", "clearQueue", "clearWorkspace", "popQueue", "trimQueue"]);

export function ipcRequestTimeout(action: Action): number {
  return LONG_QUEUE_ACTIONS.has(action) ? QUEUE_MUTATION_TIMEOUT_MS : DEFAULT_IPC_REQUEST_TIMEOUT_MS;
}

export const MAX_MESSAGE_MIB = 512;
export const MAX_MESSAGE_BYTES = MAX_MESSAGE_MIB * 1024 * 1024;

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
  const action = request.action;
  if (typeof action !== "string") throw new ClineConsoleError("INVALID_REQUEST", "action must be a string.");
  const validActions: Action[] = ["newTask", "reloadTask", "resumeHistoryTask", "resumePreemptedQueueTask", "finishUnfinishedTasks", "confirmCompletion", "skipWaitingTask", "sendMessage", "cancelTask", "preemptQueueTask", "status", "capabilities", "enqueueTasks", "enqueueMessages", "replaceQueue", "clearQueue", "clearWorkspace", "popQueue", "trimQueue", "pauseQueue", "resumeQueue", "continueQueue", "relaunchQueue", "queueStatus", "enqueueContext", "activity", "ping"];
  if (!validActions.includes(action)) throw new ClineConsoleError("INVALID_ACTION", `Unknown action: ${action}. Valid actions are: ${validActions.join(", ")}.`);
  if (typeof request.workspace !== "string" || !request.workspace) throw new ClineConsoleError("INVALID_WORKSPACE", "workspace is required.");
  return { protocolVersion: request.protocolVersion, requestId: request.requestId, action, workspace: request.workspace, payload: request.payload } as IpcRequest;
}

export function serializeResponse(response: IpcResponse): string { return `${JSON.stringify(response)}\n`; }
