import type { ClineCapabilities } from "./types";

export const UNAVAILABLE_CAPABILITIES: ClineCapabilities = {
  newTask: false, followup: false, cancel: false, taskStatus: false, taskId: false,
  directApi: false, commandApi: false, webviewBridge: false
};
