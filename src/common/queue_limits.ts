export const RECOMMENDED_QUEUE_TASK_LIMIT = 1_000;

export function queueScaleWarning(currentCount: number, addedCount: number, replace = false): string | undefined {
  const resultingCount = replace ? addedCount : currentCount + addedCount;
  if (resultingCount <= RECOMMENDED_QUEUE_TASK_LIMIT) return undefined;
  return `Resulting queue contains ${resultingCount} active tasks, above the recommended ${RECOMMENDED_QUEUE_TASK_LIMIT}-task limit. The operation will continue, but queue persistence and display may take longer.`;
}
