export type Action = "newTask" | "sendMessage" | "cancelTask" | "status" | "capabilities" | "enqueueTasks" | "enqueueMessages" | "queueStatus" | "activity";

export interface QueueStatusItem {
  position: number;
  id: string;
  kind: "task" | "message";
  state: "queued" | "running";
  title: string;
  sourcePath: string;
  queuedAt: string;
  dispatchedAt?: string;
}

export interface QueueStatus {
  workspace: string;
  queueLength: number;
  running: number;
  queued: number;
  completed: number;
  failed: number;
  items: QueueStatusItem[];
}

export interface IpcRequest {
  protocolVersion: 1;
  requestId: string;
  action: Action;
  workspace: string;
  payload?: { prompt?: string; message?: string; tasks?: Array<{ sourcePath: string; prompt: string }>; messages?: Array<{ sourcePath: string; message: string; sessionId: string }> };
}

export interface IpcResponse {
  protocolVersion: 1;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface WorkspaceRegistration {
  protocolVersion: 1;
  id: string;
  workspace: string;
  socketPath: string;
  pid: number;
  registeredAt: string;
}
