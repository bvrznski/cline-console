import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { taskTitle } from "../common/task_title";

export interface HistoryQueueItem {
  id: string;
  kind?: "task" | "message";
  sourcePath: string;
  prompt: string;
  reflective?: boolean;
  scopePath?: string;
  reflectionRequested?: boolean;
  completionVerificationRequested?: boolean;
  completionVerificationRounds?: number;
  userConfirmedCompletion?: boolean;
  targetSessionId?: string;
  resumeSessionId?: string;
  state: string;
  queuedAt: string;
  dispatchedAt?: string;
  finishedAt?: string;
  sessionId?: string;
  lastCompletionMarker?: string;
  lastRecoveryMarker?: string;
  lastFailureMarker?: string;
  lastYoloRestartMarker?: string;
  lastYoloRestartAt?: string;
  yoloRestartCount?: number;
  lastTestTimeoutMarker?: string;
  lastScopeViolationMarker?: string;
  pendingRecoveryContinuation?: { kind: "context_overflow" | "task_failure"; marker: string; sessionId: string; message: string };
  incompleteCompletionClaims?: number;
  unchangedCompletionCorrectionRounds?: number;
  error?: string;
}

export interface HistoryEventInput {
  type: string;
  taskId?: string;
  queueItemId?: string;
  runId?: string;
  clineSessionId?: string;
  source: "cline" | "cline-console" | "cli" | "scanner" | "migration";
  observed?: boolean;
  payload?: unknown;
}

export function historyDatabasePath(): string {
  const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(base, "cline-console", "history.sqlite3");
}

export class HistoryStore {
  private readonly database: Database.Database;

  constructor(readonly file = historyDatabasePath()) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(file), 0o700);
    // Electron's extension host may expose process.report.getReport() but return
    // undefined. better-sqlite3's automatic libc probe then dereferences
    // report.header before it ever opens the database. Supplying the packaged
    // native binding explicitly bypasses that fragile probe.
    this.database = new Database(file, { timeout: 5_000, fileMustExist: false, nativeBinding: packagedNativeBinding() });
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("synchronous = FULL");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("wal_autocheckpoint = 1000");
    this.database.pragma("journal_size_limit = 67108864");
    this.migrate();
    const integrity = this.database.pragma("quick_check", { simple: true });
    if (integrity !== "ok") { this.database.close(); throw new Error(`SQLite quick_check failed: ${String(integrity)}`); }
    chmodSync(file, 0o600);
  }

  close(): void {
    if (!this.database.open) return;
    this.database.pragma("wal_checkpoint(PASSIVE)");
    this.database.close();
  }

  registerWorkspace(workspace: string, metadata: Record<string, unknown> = {}): string {
    const id = digest(workspace);
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO workspaces(id, canonical_path, first_seen_at, last_seen_at, metadata_json)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(canonical_path) DO UPDATE SET last_seen_at=excluded.last_seen_at, metadata_json=excluded.metadata_json`)
      .run(id, workspace, now, now, json(metadata));
    return id;
  }

  recordQueueSnapshot(workspace: string, items: HistoryQueueItem[], reason: string, queueMetadata: Record<string, unknown> = {}): void {
    const workspaceId = this.registerWorkspace(workspace);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE queue_entries SET state='cleared', position=NULL, updated_at=? WHERE workspace_id=? AND state IN ('queued','running')").run(now, workspaceId);
      const task = this.database.prepare(`INSERT INTO tasks(id, workspace_id, kind, initial_prompt, prompt_sha256, title, source_path, origin, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, source_path=excluded.source_path`);
      const queue = this.database.prepare(`INSERT INTO queue_entries(id, workspace_id, task_id, kind, state, position, queued_at, dispatched_at, finished_at, target_session_id, resume_session_id, cline_session_id, error, metadata_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, position=excluded.position, dispatched_at=excluded.dispatched_at, finished_at=excluded.finished_at, cline_session_id=excluded.cline_session_id, error=excluded.error, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`);
      const run = this.database.prepare(`INSERT INTO task_runs(id, task_id, workspace_id, attempt, cline_session_id, state, dispatched_at, finished_at, error, metadata_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET cline_session_id=excluded.cline_session_id, state=excluded.state, finished_at=excluded.finished_at, error=excluded.error, metadata_json=excluded.metadata_json, updated_at=excluded.updated_at`);
      const snapshot = this.database.prepare(`INSERT OR IGNORE INTO prompt_snapshots(id, workspace_id, task_id, prompt_kind, content, sha256, byte_length, source, version, created_at, metadata_json)
        VALUES (?, ?, ?, 'initial_task', ?, ?, ?, ?, NULL, ?, '{}')`);
      for (let position = 0; position < items.length; position += 1) {
        const item = items[position];
        const taskId = item.id;
        task.run(taskId, workspaceId, item.kind ?? "task", item.prompt, digest(item.prompt), taskTitle(item.prompt) ?? "(untitled)", item.sourcePath, origin(item.sourcePath), item.queuedAt || now, now);
        snapshot.run(`${taskId}:initial`, workspaceId, taskId, item.prompt, digest(item.prompt), Buffer.byteLength(item.prompt), item.sourcePath, item.queuedAt || now);
        queue.run(item.id, workspaceId, taskId, item.kind ?? "task", item.state, position + 1, item.queuedAt, item.dispatchedAt ?? null, item.finishedAt ?? null, item.targetSessionId ?? null, item.resumeSessionId ?? null, item.sessionId ?? null, item.error ?? null, json({ lastCompletionMarker: item.lastCompletionMarker, lastRecoveryMarker: item.lastRecoveryMarker, lastFailureMarker: item.lastFailureMarker, lastYoloRestartMarker: item.lastYoloRestartMarker, lastYoloRestartAt: item.lastYoloRestartAt, yoloRestartCount: item.yoloRestartCount, lastTestTimeoutMarker: item.lastTestTimeoutMarker, pendingRecoveryContinuation: item.pendingRecoveryContinuation, incompleteCompletionClaims: item.incompleteCompletionClaims, unchangedCompletionCorrectionRounds: item.unchangedCompletionCorrectionRounds, reflective: item.reflective, reflectionRequested: item.reflectionRequested, completionVerificationRequested: item.completionVerificationRequested, completionVerificationRounds: item.completionVerificationRounds, userConfirmedCompletion: item.userConfirmedCompletion }), now);
        if (item.dispatchedAt) run.run(`${item.id}:${item.dispatchedAt}`, taskId, workspaceId, 1, item.sessionId ?? item.resumeSessionId ?? null, item.state, item.dispatchedAt, item.finishedAt ?? null, item.error ?? null, json({ targetSessionId: item.targetSessionId }), now);
      }
      this.insertEvent(workspaceId, { type: "queue_snapshot", source: "cline-console", payload: { reason, itemCount: items.length, ...queueMetadata, items: items.map(item => ({ id: item.id, kind: item.kind ?? "task", state: item.state, sessionId: item.sessionId, sourcePath: item.sourcePath })) } }, now);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  /** Persist newly appended entries without rewriting every older queue task. */
  recordQueueAppend(workspace: string, items: HistoryQueueItem[], positionOffset: number): void {
    if (!items.length) return;
    const workspaceId = this.registerWorkspace(workspace);
    const now = new Date().toISOString();
    const task = this.database.prepare(`INSERT INTO tasks(id, workspace_id, kind, initial_prompt, prompt_sha256, title, source_path, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=excluded.updated_at, source_path=excluded.source_path`);
    const queue = this.database.prepare(`INSERT INTO queue_entries(id, workspace_id, task_id, kind, state, position, queued_at, dispatched_at, finished_at, target_session_id, resume_session_id, cline_session_id, error, metadata_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, position=excluded.position, updated_at=excluded.updated_at`);
    const snapshot = this.database.prepare(`INSERT OR IGNORE INTO prompt_snapshots(id, workspace_id, task_id, prompt_kind, content, sha256, byte_length, source, version, created_at, metadata_json)
      VALUES (?, ?, ?, 'initial_task', ?, ?, ?, ?, NULL, ?, '{}')`);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      items.forEach((item, index) => {
        const hash = digest(item.prompt);
        task.run(item.id, workspaceId, item.kind ?? "task", item.prompt, hash, taskTitle(item.prompt) ?? "(untitled)", item.sourcePath, origin(item.sourcePath), item.queuedAt || now, now);
        snapshot.run(`${item.id}:initial`, workspaceId, item.id, item.prompt, hash, Buffer.byteLength(item.prompt), item.sourcePath, item.queuedAt || now);
        queue.run(item.id, workspaceId, item.id, item.kind ?? "task", item.state, positionOffset + index + 1, item.queuedAt, null, null, item.targetSessionId ?? null, item.resumeSessionId ?? null, null, null, json({ reflective: item.reflective }), now);
      });
      this.insertEvent(workspaceId, { type: "queue_append", source: "cline-console", payload: { itemCount: items.length, firstPosition: positionOffset + 1, itemIds: items.map(item => item.id) } }, now);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  /** Remove one waiting entry without rebuilding the complete queue snapshot. */
  recordQueueRemove(workspace: string, itemId: string, removedPosition: number): void {
    const workspaceId = this.registerWorkspace(workspace);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`UPDATE queue_entries
        SET state='cleared', position=NULL, updated_at=?
        WHERE workspace_id=? AND id=? AND state='queued'`).run(now, workspaceId, itemId);
      this.database.prepare(`UPDATE queue_entries
        SET position=position-1, updated_at=?
        WHERE workspace_id=? AND state IN ('queued','running') AND position>?`).run(now, workspaceId, removedPosition);
      this.insertEvent(workspaceId, {
        type: "queue_remove", source: "cline-console", queueItemId: itemId,
        payload: { itemId, removedPosition }
      }, now);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  /** Clear a queue suffix in one transaction and retain the first N active entries. */
  recordQueueTrim(workspace: string, itemIds: string[], keep: number): void {
    if (!itemIds.length) return;
    const workspaceId = this.registerWorkspace(workspace);
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const clear = this.database.prepare(`UPDATE queue_entries
        SET state='cleared', position=NULL, updated_at=?
        WHERE workspace_id=? AND id=? AND state='queued'`);
      for (const itemId of itemIds) clear.run(now, workspaceId, itemId);
      this.insertEvent(workspaceId, {
        type: "queue_trim", source: "cline-console",
        payload: { keep, removed: itemIds.length, itemIds }
      }, now);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  recordEvent(workspace: string, event: HistoryEventInput): string {
    const id = randomUUID(), workspaceId = this.registerWorkspace(workspace);
    this.insertEvent(workspaceId, event, new Date().toISOString(), id);
    return id;
  }

  recordTask(workspace: string, taskId: string, prompt: string, sourcePath: string, kind = "task", metadata: Record<string, unknown> = {}): void {
    const workspaceId = this.registerWorkspace(workspace), now = new Date().toISOString();
    this.database.prepare(`INSERT INTO tasks(id, workspace_id, kind, initial_prompt, prompt_sha256, title, source_path, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, source_path=excluded.source_path, updated_at=excluded.updated_at`)
      .run(taskId, workspaceId, kind, prompt, digest(prompt), taskTitle(prompt) ?? "(untitled)", sourcePath, origin(sourcePath), now, now);
    this.recordPromptSnapshot(workspace, "initial_task", prompt, sourcePath, undefined, taskId, metadata);
  }

  recordPromptSnapshot(workspace: string, kind: string, content: string | undefined, source: string, version?: string, taskId?: string, metadata: Record<string, unknown> = {}): string {
    const workspaceId = this.registerWorkspace(workspace), value = content ?? "", hash = digest(value);
    const id = digest([workspaceId, taskId ?? "", kind, hash, source, version ?? ""].join("\0"));
    this.database.prepare(`INSERT OR IGNORE INTO prompt_snapshots(id, workspace_id, task_id, prompt_kind, content, sha256, byte_length, source, version, created_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, workspaceId, taskId ?? null, kind, content ?? null, hash, Buffer.byteLength(value), source, version ?? null, new Date().toISOString(), json(metadata));
    return id;
  }

  listTasks(workspace?: string, limit = 100): Array<Record<string, unknown>> {
    const safeLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
    const sql = `SELECT t.id, w.canonical_path AS workspace, t.kind, t.title, t.source_path, t.origin,
      t.created_at, t.updated_at, q.state, q.cline_session_id, q.dispatched_at, q.finished_at, q.error
      FROM tasks t JOIN workspaces w ON w.id=t.workspace_id LEFT JOIN queue_entries q ON q.task_id=t.id
      ${workspace ? "WHERE w.canonical_path = ?" : ""} ORDER BY t.updated_at DESC LIMIT ?`;
    return this.database.prepare(sql).all(...(workspace ? [workspace, safeLimit] : [safeLimit])) as Array<Record<string, unknown>>;
  }

  getTask(id: string): Record<string, unknown> | undefined {
    const task = this.database.prepare(`SELECT t.*, w.canonical_path AS workspace FROM tasks t JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=?`).get(id) as Record<string, unknown> | undefined;
    if (!task) return undefined;
    return { ...task, runs: this.database.prepare("SELECT * FROM task_runs WHERE task_id=? ORDER BY dispatched_at").all(id), events: this.database.prepare("SELECT * FROM events WHERE task_id=? OR queue_item_id=? ORDER BY occurred_at").all(id, id) };
  }

  private insertEvent(workspaceId: string, event: HistoryEventInput, occurredAt: string, id = randomUUID()): void {
    this.database.prepare(`INSERT INTO events(id, workspace_id, task_id, queue_item_id, run_id, cline_session_id, event_type, source, truth_kind, occurred_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, workspaceId, event.taskId ?? null, event.queueItemId ?? null, event.runId ?? null, event.clineSessionId ?? null, event.type, event.source, event.observed ? "observed" : "derived", occurredAt, json(event.payload ?? {}));
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, display_name TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, metadata_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), kind TEXT NOT NULL, initial_prompt TEXT NOT NULL, prompt_sha256 TEXT NOT NULL, title TEXT NOT NULL, source_path TEXT NOT NULL, origin TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompt_snapshots(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), task_id TEXT REFERENCES tasks(id), prompt_kind TEXT NOT NULL, content TEXT, sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, source TEXT, version TEXT, created_at TEXT NOT NULL, metadata_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue_entries(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), task_id TEXT REFERENCES tasks(id), kind TEXT NOT NULL, state TEXT NOT NULL, position INTEGER, queued_at TEXT NOT NULL, dispatched_at TEXT, finished_at TEXT, target_session_id TEXT, resume_session_id TEXT, cline_session_id TEXT, error TEXT, metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_runs(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), attempt INTEGER NOT NULL, cline_session_id TEXT, state TEXT NOT NULL, dispatched_at TEXT NOT NULL, finished_at TEXT, error TEXT, metadata_json TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), task_id TEXT, queue_item_id TEXT, run_id TEXT, cline_session_id TEXT, event_type TEXT NOT NULL, source TEXT NOT NULL, truth_kind TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_tasks_workspace_updated ON tasks(workspace_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_queue_workspace_state ON queue_entries(workspace_id, state);
      CREATE INDEX IF NOT EXISTS idx_runs_session ON task_runs(cline_session_id);
      CREATE INDEX IF NOT EXISTS idx_events_workspace_time ON events(workspace_id, occurred_at DESC);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
    `);
  }
}

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function json(value: unknown): string { return JSON.stringify(value, (_key, item) => item === undefined ? null : item); }
function origin(sourcePath: string): string { return sourcePath.startsWith("cline-history:") ? "cline-history" : sourcePath === "<inline-or-stdin>" ? "inline" : "file"; }

function packagedNativeBinding(): string {
  const packageRoot = path.dirname(require.resolve("better-sqlite3/package.json"));
  const platform = process.platform === "linux" && linuxUsesMusl() ? "linuxmusl" : process.platform;
  return path.join(packageRoot, "prebuilds", `${platform}-${process.arch}.node`);
}

function linuxUsesMusl(): boolean {
  if (process.platform !== "linux") return false;
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  // An unavailable Electron diagnostic report is not evidence of musl. The
  // extension targets ordinary desktop distributions, where glibc is the safe
  // fallback; actual musl runtimes expose a report without glibcVersionRuntime.
  return report !== undefined && report.header !== undefined && !report.header.glibcVersionRuntime;
}
