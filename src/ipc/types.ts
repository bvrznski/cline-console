export type Action = "newTask" | "reloadTask" | "resumeHistoryTask" | "resumePreemptedQueueTask" | "finishUnfinishedTasks" | "confirmCompletion" | "skipWaitingTask" | "sendMessage" | "cancelTask" | "preemptQueueTask" | "status" | "capabilities" | "enqueueTasks" | "enqueueMessages" | "replaceQueue" | "clearQueue" | "clearWorkspace" | "popQueue" | "trimQueue" | "pauseQueue" | "resumeQueue" | "continueQueue" | "relaunchQueue" | "queueStatus" | "enqueueContext" | "activity" | "ping";

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cacheReads: number;
  cacheWrites: number;
  sessions: number;
}

export interface QueueStatusItem {
  position?: number;
  id: string;
  kind: "task" | "message";
  state: "queued" | "running" | "interrupted" | "waiting" | "completed" | "failed" | "closed";
  title: string;
  sourcePath: string;
  scopePath?: string;
  queuedAt: string;
  dispatchedAt?: string;
  activeMs?: number;
  activeSince?: string;
  sessionId?: string;
  tokenUsage?: TokenUsage;
  lastYoloRestartAt?: string;
  yoloRestartCount?: number;
}

export interface QueueStatus {
  workspace: string;
  paused: boolean;
  queueLength: number;
  running: number;
  interrupted?: number;
  queued: number;
  completed: number;
  failed: number;
  skipped?: number;
  tokenUsage?: TokenUsage;
  timing?: {
    sampleCount: number;
    averageMs?: number;
    estimateMs?: number;
    lastMs?: number;
    medianMs?: number;
    p25Ms?: number;
    p75Ms?: number;
    p90Ms?: number;
    trimmedMeanMs?: number;
    ewmaMs?: number;
    minMs?: number;
    maxMs?: number;
    standardDeviationMs?: number;
    coefficientVariation?: number;
    tasksPerHour?: number;
    recentMedianMs?: number;
    trend?: "faster" | "stable" | "slower";
    spreadRatio?: number;
    confidence?: "low" | "medium" | "high";
  };
  items: QueueStatusItem[];
}

export interface IpcRequest {
  protocolVersion: 1;
  requestId: string;
  action: Action;
  workspace: string;
  payload?: { prompt?: string; message?: string; sessionId?: string; winnerWorkspace?: string; modelIdentity?: string; force?: boolean; keep?: number; allowDuplicates?: boolean; freshOnInterrupted?: boolean; selector?: string; resolvedSelector?: string; selectorType?: "file" | "title" | "id"; tasks?: Array<{ sourcePath: string; prompt: string; reflective?: boolean; scopePath?: string }>; messages?: Array<{ sourcePath: string; message: string; sessionId: string }> };
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
