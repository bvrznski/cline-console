import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface YoloRestartRequest {
  version: 1;
  kind: "yolo_consecutive_mistakes";
  id: string;
  workspace: string;
  queueItemId: string;
  sessionId: string;
  failureMarker: string;
  errorText: string;
  requestedAt: string;
}

export async function writeYoloRestartRequest(directory: string, request: Omit<YoloRestartRequest, "version" | "kind" | "id" | "requestedAt">): Promise<string> {
  const value: YoloRestartRequest = { version: 1, kind: "yolo_consecutive_mistakes", id: randomUUID(), requestedAt: new Date().toISOString(), ...request };
  const target = path.join(directory, `restart-${value.id}.json`), temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(temporary, target);
  return target;
}

export function parseYoloRestartRequest(value: unknown): YoloRestartRequest | undefined {
  const item = value as Partial<YoloRestartRequest>;
  return item?.version === 1 && item.kind === "yolo_consecutive_mistakes"
    && [item.id, item.workspace, item.queueItemId, item.sessionId, item.failureMarker, item.errorText, item.requestedAt].every(field => typeof field === "string" && field.length > 0)
    ? item as YoloRestartRequest : undefined;
}
