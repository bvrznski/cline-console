export type PersistentQueueState = "queued" | "running" | "completed" | "failed" | "skipped";

const ALLOWED_TRANSITIONS: Readonly<Record<PersistentQueueState, readonly PersistentQueueState[]>> = {
  queued: ["running"],
  running: ["queued", "completed", "failed", "skipped"],
  completed: [],
  failed: [],
  skipped: []
};

/** Validate a persisted queue transition before it is applied. */
export function queueStateTransition(current: PersistentQueueState, next: PersistentQueueState): PersistentQueueState {
  if (current === next) return next;
  if (ALLOWED_TRANSITIONS[current].includes(next)) return next;
  throw new Error(`Invalid persisted queue transition: ${current} -> ${next}`);
}
