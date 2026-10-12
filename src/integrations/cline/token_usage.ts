import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { QueueStatus, TokenUsage } from "../../ipc/types";

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, total: 0, cacheReads: 0, cacheWrites: 0, sessions: 0 };
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    total: left.total + right.total,
    cacheReads: left.cacheReads + right.cacheReads,
    cacheWrites: left.cacheWrites + right.cacheWrites,
    sessions: left.sessions + right.sessions
  };
}

export async function readClineTokenUsage(sessionIds: Iterable<string>, storageOverride?: string): Promise<Map<string, TokenUsage>> {
  const wanted = new Set(sessionIds);
  const result = new Map<string, TokenUsage>();
  if (!wanted.size) return result;
  const storage = storageOverride || process.env.CLINE_VSCODE_STORAGE_DIR?.trim()
    || path.join(os.homedir(), ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev");
  try {
    const history = JSON.parse(await fs.readFile(path.join(storage, "state", "taskHistory.json"), "utf8")) as Array<Record<string, unknown>>;
    for (const entry of history) {
      const sessionId = typeof entry.id === "string" ? entry.id : undefined;
      if (!sessionId || !wanted.has(sessionId)) continue;
      const input = count(entry.tokensIn), output = count(entry.tokensOut);
      result.set(sessionId, {
        input,
        output,
        total: input + output,
        cacheReads: count(entry.cacheReads),
        cacheWrites: count(entry.cacheWrites),
        sessions: 1
      });
    }
  } catch { /* Token telemetry is optional and must not break queue control. */ }
  return result;
}

export function attachTokenUsage(status: QueueStatus, usage: ReadonlyMap<string, TokenUsage>, ownedSessionIds: Iterable<string>): QueueStatus {
  let total = emptyTokenUsage();
  const unique = new Set(ownedSessionIds);
  for (const sessionId of unique) {
    const value = usage.get(sessionId);
    if (value) total = addTokenUsage(total, value);
  }
  return {
    ...status,
    tokenUsage: total,
    items: status.items.map(item => item.sessionId && usage.has(item.sessionId)
      ? { ...item, tokenUsage: usage.get(item.sessionId) }
      : item)
  };
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}
