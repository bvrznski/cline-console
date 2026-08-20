export interface ClineCapabilities {
  newTask: boolean;
  followup: boolean;
  cancel: boolean;
  taskStatus: boolean;
  taskId: boolean;
  directApi: boolean;
  commandApi: boolean;
  webviewBridge: boolean;
}

export interface ClineStatus {
  connected: boolean;
  version?: string;
  task: "active" | "completed" | "failed" | "none" | "unknown";
  state: "running" | "waiting" | "idle" | "completed" | "failed" | "submitted" | "cancelled" | "unknown";
  taskId?: string;
  title?: string;
  sourcePath?: string;
  observedAt?: string;
  detail?: string;
}

export interface TaskResult { taskStarted: boolean; taskId?: string; }

export interface ClineAdapter {
  detect(): Promise<boolean>;
  getVersion(): Promise<string | undefined>;
  getCapabilities(): Promise<ClineCapabilities>;
  newTask(prompt: string): Promise<TaskResult>;
  resumeTask?(taskId: string): Promise<TaskResult>;
  sendMessage(message: string): Promise<void>;
  cancelTask(): Promise<void>;
  getStatus(): Promise<ClineStatus>;
}
