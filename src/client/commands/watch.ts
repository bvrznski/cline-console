import { promises as fs, watch as watchFs, type FSWatcher } from "node:fs";
import path from "node:path";
import stringWidth from "string-width";
import { bold, color, stateColor, supportsColor, type TerminalColor } from "../../common/terminal";
import { formatTokenCount } from "../../common/token_count";
import { addTokenUsage, emptyTokenUsage } from "../../integrations/cline/token_usage";
import type { QueueStatus } from "../../ipc/types";
import { makeRequest } from "../../ipc/protocol";
import { requestOverSocket } from "../../ipc/transport";
import { discoverPersistedQueueStatuses, reconcileQueueStatus, TASK_DISPATCH_DELAY_MS } from "../../extension/task_queue";
import { queueStateDirectory, runtimeDirectory } from "../../extension/workspace_registry";
import { loadRegistrations } from "../ipc_client";

export interface WatchActivity {
  status?: string;
  queueActive?: boolean;
  modelIdentity?: string;
  modelConflict?: { winnerWorkspace: string; modelIdentity: string; interruptedAt: string };
}
export interface WatchSection { workspace: string; queue?: QueueStatus; activity?: WatchActivity; modelPeers?: WatchSection[]; error?: string; }
const lastLiveQueues = new Map<string, QueueStatus>();
const consecutiveCompanionFailures = new Map<string, number>();
const companionFailureSince = new Map<string, number>();
const COMPANION_POLL_TIMEOUT_MS = 5_000;
const COMPANION_FAILURE_WARNING_THRESHOLD = 4;
const COMPANION_FAILURE_WARNING_AFTER_MS = 20_000;
const WATCH_TERMINAL_TITLE = "[keep] Cline Console Watch";
export function shouldWarnCompanionFailure(failures: number, failedSince: number, now = Date.now()): boolean {
  return failures >= COMPANION_FAILURE_WARNING_THRESHOLD
    && now - failedSince >= COMPANION_FAILURE_WARNING_AFTER_MS;
}
export function watchTerminalTitleSequence(title = WATCH_TERMINAL_TITLE): string { return `\x1b]0;${title}\x07`; }
const ACTIVE_QUEUE_STATES = new Set(["running", "waiting", "interrupted", "queued"]);
export function hasActiveQueue(queue?: QueueStatus): boolean {
  if (!queue) return false;
  return queue.items.some(item => ACTIVE_QUEUE_STATES.has(item.state))
    || queue.running > 0
    || queue.queued > 0;
}
export function visiblePersistedQueues(persisted: QueueStatus[], registrations: Array<{ workspace: string }>, workspace?: string): QueueStatus[] {
  if (workspace) return persisted.filter(queue => queue.workspace === workspace && hasActiveQueue(queue));
  const openWorkspaces = new Set(registrations.map(registration => registration.workspace));
  return persisted.filter(queue => openWorkspaces.has(queue.workspace) && hasActiveQueue(queue));
}
// Task text must never inject terminal control sequences into a full-screen UI.
export function watchText(text: string): string { return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " "); }

function clipToTerminalWidth(text: string, width: number): string {
  const clean = watchText(text);
  if (width <= 0) return "";
  if (stringWidth(clean) <= width) return clean;
  let clipped = "";
  for (const character of clean) {
    const candidate = clipped + character;
    if (stringWidth(candidate) > width) break;
    clipped = candidate;
  }
  return clipped;
}

function terminalCell(text: string, width: number): string {
  const clipped = clipToTerminalWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - stringWidth(clipped)));
}

export function renderWatch(sections: WatchSection[], width = 100, colors = false, offset = 0, now = Date.now()): string {
  const columns = Math.max(1, width - 1);
  const line = (text: string, tone: TerminalColor = "gray") => color(clipToTerminalWidth(text, columns), tone, colors);
  const cells = (values: Array<[string, number, TerminalColor]>) => {
    let remaining = columns;
    return values.map(([text, size, tone]) => {
      const length = Math.min(size, remaining); remaining -= length;
      return color(terminalCell(text, length), tone, colors);
    }).join("");
  };
  const metricTable = (fields: Array<[string, string, TerminalColor]>): string[] => {
    const count = columns >= 96 ? 4 : columns >= 64 ? 2 : 1;
    const inner = Math.max(1, columns - count - 1);
    const baseWidth = Math.floor(inner / count);
    const widths = Array.from({ length: count }, (_, index) => baseWidth + (index < inner % count ? 1 : 0));
    const border = (left: string, join: string, right: string) => line(`${left}${widths.map(size => "─".repeat(size)).join(join)}${right}`, "gray");
    const row = (values: Array<[string, TerminalColor]>) => `│${widths.map((size, index) => {
      const [value, tone] = values[index] ?? ["", "gray" as TerminalColor];
      return color(terminalCell(value, size), tone, colors);
    }).join("│")}│`;
    const result = [bold(line("ESTIMATES", "cyan"), colors), border("┌", "┬", "┐")];
    for (let index = 0; index < fields.length; index += count) {
      const group = fields.slice(index, index + count);
      result.push(row(group.map(([label]) => [label, "cyan"] as [string, TerminalColor])));
      result.push(row(group.map(([, value, tone]) => [value, tone] as [string, TerminalColor])));
      if (index + count < fields.length) result.push(border("├", "┼", "┤"));
    }
    result.push(border("└", "┴", "┘"));
    return result;
  };
  const elapsed = (value?: string) => {
    const seconds = Math.floor((now - Date.parse(value ?? "")) / 1000);
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--:--";
    return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  };
  const duration = (milliseconds?: number) => {
    if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return "--:--:--";
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}:${Math.floor(seconds / 60 % 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  };
  const startDuration = (milliseconds?: number) => {
    if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return "--";
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds / 3600 % 24);
    const minutes = Math.floor(seconds / 60 % 60);
    if (days > 0) return `${days}d ${hours.toString().padStart(2, "0")}h ${minutes.toString().padStart(2, "0")}m`;
    if (seconds >= 3600) return `${Math.floor(seconds / 3600).toString().padStart(2, "0")}h ${minutes.toString().padStart(2, "0")}m`;
    return `${minutes.toString().padStart(2, "0")}m ${(seconds % 60).toString().padStart(2, "0")}s`;
  };
  const finishDate = (milliseconds?: number) => {
    if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return "--";
    const value = new Date(now + milliseconds);
    const pad = (part: number) => part.toString().padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
  };
  const lines = [bold(line(`CLINE CONSOLE | LIVE | ${new Date(now).toLocaleTimeString()} | ${sections.length} workspace(s)`, "cyan"), colors)];
  lines.push(line("q/Ctrl+C exit  ↑↓ j/k scroll  |  refresh 2s  |  read-only", "gray"));
  const globalUsage = sections.reduce((total, section) => section.queue?.tokenUsage ? addTokenUsage(total, section.queue.tokenUsage) : total, emptyTokenUsage());
  lines.push(bold(line(`GLOBAL TOKENS: ${formatTokenCount(globalUsage.total)} total | ${formatTokenCount(globalUsage.input)} in | ${formatTokenCount(globalUsage.output)} out | cache R ${formatTokenCount(globalUsage.cacheReads)} W ${formatTokenCount(globalUsage.cacheWrites)} | ${globalUsage.sessions} managed session(s)`, "magenta"), colors));
  if (!sections.length) lines.push(line("No active queues."));
  const currentEstimate = (section: WatchSection): number | undefined => {
    const queue = section.queue;
    if (!queue) return undefined;
    const current = queue.items.find(item => ["running", "waiting", "interrupted"].includes(item.state));
    if (!current) return 0;
    const estimate = queue.timing?.estimateMs ?? queue.timing?.averageMs;
    if (estimate === undefined) return undefined;
    const elapsedMs = current.activeMs !== undefined || current.activeSince
      ? (current.activeMs ?? 0) + (current.state === "running" && current.activeSince ? Math.max(0, now - Date.parse(current.activeSince)) : 0)
      : current.dispatchedAt ? Math.max(0, now - Date.parse(current.dispatchedAt)) : undefined;
    if (elapsedMs === undefined) return estimate;
    if (elapsedMs < estimate) return estimate - elapsedMs;
    const conservative = queue.timing?.p90Ms ?? queue.timing?.p75Ms ?? estimate;
    return elapsedMs < conservative ? conservative - elapsedMs : estimate;
  };
  const sharedModelDelay = (section: WatchSection): { milliseconds?: number; workspace?: string } => {
    const conflict = section.activity?.modelConflict;
    if (!conflict) return {};
    const winner = [...sections, ...(section.modelPeers ?? [])].find(candidate => candidate.workspace === conflict.winnerWorkspace
      && candidate.activity?.status === "running"
      && candidate.activity.modelIdentity === conflict.modelIdentity);
    if (!winner) return { workspace: conflict.winnerWorkspace };
    const remaining = currentEstimate(winner);
    return { milliseconds: remaining === undefined ? undefined : remaining + TASK_DISPATCH_DELAY_MS, workspace: winner.workspace };
  };
  for (const section of sections) {
    lines.push(line("─".repeat(width)), line(section.workspace, "cyan"));
    if (section.error) lines.push(line(section.error, "red"));
    const queue = section.queue;
    if (!queue) continue;
    const current = queue.items.find(item => ["running", "waiting", "interrupted"].includes(item.state));
    const sampleCount = queue.timing?.sampleCount ?? 0;
    const averageMs = queue.timing?.averageMs;
    const estimateMs = queue.timing?.estimateMs ?? averageMs;
    const lastMs = queue.timing?.lastMs;
    const medianMs = queue.timing?.medianMs;
    const p75Ms = queue.timing?.p75Ms;
    const conservativeMs = queue.timing?.p90Ms ?? p75Ms ?? estimateMs;
    const confidence = queue.timing?.confidence ?? (sampleCount ? "low" : "none");
    const externalModelWait = sharedModelDelay(section);
    const currentElapsedMs = current
      ? current.activeMs !== undefined || current.activeSince
        ? (current.activeMs ?? 0) + (current.state === "running" && current.activeSince ? Math.max(0, now - Date.parse(current.activeSince)) : 0)
        : current.dispatchedAt ? Math.max(0, now - Date.parse(current.dispatchedAt)) : undefined
      : undefined;
    const currentOverrunMs = current && estimateMs !== undefined && currentElapsedMs !== undefined && currentElapsedMs >= estimateMs
      ? currentElapsedMs - estimateMs : undefined;
    const currentRemainingMs = !current || estimateMs === undefined ? undefined
      : currentElapsedMs === undefined ? estimateMs
      : currentElapsedMs < estimateMs ? estimateMs - currentElapsedMs
      : conservativeMs !== undefined && currentElapsedMs < conservativeMs ? conservativeMs - currentElapsedMs
      : undefined;
    const queuedTasks = queue.items.filter(item => item.state === "queued").length;
    // Once the current task exceeds the historical P90 there is no defensible
    // exact residual. Keep the whole-queue work estimate useful by assigning
    // one additional typical-task duration, and mark the result approximate.
    const fallbackCurrentRemainingMs = current && currentRemainingMs === undefined && estimateMs !== undefined ? estimateMs : undefined;
    const approximateQueueEta = fallbackCurrentRemainingMs !== undefined;
    const queueRemainingMs = estimateMs === undefined
      ? undefined : (current ? currentRemainingMs ?? fallbackCurrentRemainingMs ?? 0 : 0) + queuedTasks * estimateMs;
    const queueBlocker = queue.paused ? "paused" : section.error ? "offline" : current?.state === "interrupted" ? "interrupted" : undefined;
    const remainingItems = queue.items.filter(item => ["running", "waiting", "interrupted", "queued"].includes(item.state)).length;
    lines.push(line(`TOKENS: ${formatTokenCount(queue.tokenUsage?.total)} total | ${formatTokenCount(queue.tokenUsage?.input)} in | ${formatTokenCount(queue.tokenUsage?.output)} out | cache R ${formatTokenCount(queue.tokenUsage?.cacheReads)} W ${formatTokenCount(queue.tokenUsage?.cacheWrites)} | ${queue.tokenUsage?.sessions ?? 0} session(s)`, "magenta"));
    lines.push(cells([[queue.paused ? "PAUSED" : section.error ? "OFFLINE" : "CONNECTED", 14, queue.paused ? "yellow" : section.error ? "red" : "green"], ["run", 6, "cyan"], ["wait", 6, "cyan"], ["halt", 6, "cyan"], ["done", 6, "cyan"], ["fail", 6, "cyan"]]));
    lines.push(cells([["TASK COUNTS", 14, "gray"], [String(queue.running ?? 0), 6, "yellow"], [String(queue.queued), 6, "cyan"], [String(queue.interrupted ?? queue.items.filter(i => i.state === "interrupted").length), 6, "magenta"], [String(queue.completed), 6, "green"], [String(queue.failed), 6, queue.failed ? "red" : "gray"]]));
    const remainingLabel = remainingItems === 1 ? "task" : "tasks";
    const queueEtaText = queueRemainingMs === undefined ? "--" : `${approximateQueueEta ? "~" : ""}${startDuration(queueRemainingMs)}${queueBlocker ? " active" : ""}`;
    const queueEndText = queueBlocker ? `blocked (${queueBlocker})` : `${approximateQueueEta ? "~" : ""}${finishDate(queueRemainingMs)}`;
    const queueConfidence = approximateQueueEta ? `${confidence} (current uncertain)` : confidence;
    const usingConservative = currentOverrunMs !== undefined && currentRemainingMs !== undefined;
    const currentLeft = currentOverrunMs === undefined ? startDuration(currentRemainingMs)
      : usingConservative ? `${startDuration(currentRemainingMs)} (P90)`
      : `unknown (${startDuration(currentOverrunMs)} over likely)`;
    const variation = queue.timing?.coefficientVariation;
    const throughput = queue.timing?.tasksPerHour;
    lines.push(...metricTable([
      ["QUEUE LEFT", `${remainingItems} ${remainingLabel}`, remainingItems ? "magenta" : "green"],
      ["QUEUE ETA", queueEtaText, queueRemainingMs === undefined ? "magenta" : "green"],
      ["END", queueEndText, queueBlocker ? "magenta" : "green"],
      ["CONFIDENCE", queueConfidence, "yellow"],
      ["CURRENT ELAPSED", duration(currentElapsedMs), "yellow"],
      ["CURRENT LEFT", currentLeft, "magenta"],
      ["LIKELY", duration(estimateMs), "yellow"],
      ["P75", duration(p75Ms), "yellow"],
      ["P90", duration(conservativeMs), "yellow"],
      ["SAMPLES", String(sampleCount), "yellow"],
      ["LAST", duration(lastMs), "yellow"],
      ["P50", duration(medianMs), "yellow"],
      ["AVERAGE", duration(averageMs), "yellow"],
      ["EWMA", duration(queue.timing?.ewmaMs), "yellow"],
      ["TRIMMED MEAN", duration(queue.timing?.trimmedMeanMs), "yellow"],
      ["RATE", throughput === undefined ? "--" : `${throughput.toFixed(2)} tasks/h`, "cyan"],
      ["MIN", duration(queue.timing?.minMs), "cyan"],
      ["MAX", duration(queue.timing?.maxMs), "cyan"],
      ["STDDEV", duration(queue.timing?.standardDeviationMs), "cyan"],
      ["CV", variation === undefined ? "--" : `${Math.round(variation * 100)}%`, "cyan"],
      ["RECENT P50", duration(queue.timing?.recentMedianMs), "cyan"],
      ["TREND", queue.timing?.trend ?? "--", "cyan"]
    ]));
    if (current) {
      const prefix = "CURRENT: ";
      const state = `[${current.state}] `;
      const elapsedText = ` | ELAPSED ${duration(currentElapsedMs)}`;
      const leftText = ` | LEFT ${currentLeft}`;
      if (prefix.length + state.length + elapsedText.length + leftText.length > columns) {
        lines.push(line(`${prefix}${state}${current.title}`, stateColor(current.state)));
      } else {
        const titleWidth = Math.max(0, columns - prefix.length - state.length - elapsedText.length - leftText.length);
        lines.push([
          color(prefix, "cyan", colors),
          color(state, stateColor(current.state), colors),
          color(watchText(current.title).slice(0, titleWidth), "cyan", colors),
          color(elapsedText, "yellow", colors),
          color(leftText, "magenta", colors)
        ].join(""));
      }
    } else {
      lines.push(line("CURRENT: none", "gray"));
    }
    if (current) {
      lines.push(line(`Active execution: ${duration(currentElapsedMs)} | Wall since dispatch: ${elapsed(current.dispatchedAt)}`, "yellow"));
      lines.push(line(`Task tokens: ${formatTokenCount(current.tokenUsage?.total)} total | ${formatTokenCount(current.tokenUsage?.input)} in | ${formatTokenCount(current.tokenUsage?.output)} out | cache R ${formatTokenCount(current.tokenUsage?.cacheReads)} W ${formatTokenCount(current.tokenUsage?.cacheWrites)}`, "magenta"));
      if (current.yoloRestartCount) lines.push(line(`YOLO recovery: ${current.yoloRestartCount} restart(s) requested | last ${current.lastYoloRestartAt ?? "unknown"}`, "red"));
      lines.push(line(`Source: ${current.sourcePath ?? "unknown"}`));
      if (current.scopePath) lines.push(line(`Scope: ${current.scopePath}`));
    }
    lines.push(line("QUEUE", "cyan"));
    // Build positional metadata in one pass.  The former indexOf + slice +
    // filter implementation rescanned the full queue for every row (O(n^2)),
    // which made --watch expensive precisely when it was most needed.
    let activeBefore = 0;
    const waiting = queue.items.flatMap(item => {
      const aheadCount = item.state === "queued" ? activeBefore : undefined;
      if (["running", "interrupted", "queued"].includes(item.state)) activeBefore += 1;
      return item === current ? [] : [{ item, aheadCount }];
    });
    const wide = columns >= 90;
    const positionWidth = columns >= 30 ? Math.max(4, ...waiting.map(({ item }) => String(item.position ?? "-").length + 1)) : 0;
    const stateWidth = columns >= 40 ? Math.max(6, ...waiting.map(({ item }) => item.state.length + 2)) : columns >= 25 ? 10 : 0;
    const startIn = (item: QueueStatus["items"][number], aheadCount?: number): string => {
      if (item.state !== "queued" || estimateMs === undefined || aheadCount === undefined) return "--";
      const precedingQueued = Math.max(0, aheadCount - (current ? 1 : 0));
      if (externalModelWait.workspace && externalModelWait.milliseconds === undefined) return `model: ${path.basename(externalModelWait.workspace)} unknown`;
      const modelDelayMs = externalModelWait.milliseconds ?? 0;
      if (current && currentRemainingMs === undefined) {
        const overdue = currentOverrunMs === undefined ? "current unknown" : `overdue ${startDuration(currentOverrunMs)}`;
        const prefix = modelDelayMs ? `${startDuration(modelDelayMs)} + ` : "";
        return precedingQueued === 0 ? `${prefix}${overdue}` : `${prefix}${overdue} + ${startDuration(precedingQueued * estimateMs)}`;
      }
      return startDuration(modelDelayMs + (current ? currentRemainingMs ?? 0 : 0) + precedingQueued * estimateMs);
    };
    const rowData = waiting.map(({ item, aheadCount }) => ({
      item,
      ahead: aheadCount === undefined ? "-" : String(aheadCount),
      eta: startIn(item, aheadCount)
    }));
    const aheadWidth = wide ? Math.max(8, ...rowData.map(row => row.ahead.length + 2)) : 0;
    // The actionable start estimate is more useful than the diagnostic AHEAD
    // count, so retain START IN on ordinary terminals and add AHEAD only when
    // there is enough room for both.
    const etaWidth = columns >= 70 ? Math.max(13, ...rowData.map(row => row.eta.length + 2)) : 0;
    const visibleWidths = [positionWidth, stateWidth, aheadWidth, etaWidth].filter(value => value > 0);
    const titleWidth = Math.max(1, columns - visibleWidths.reduce((sum, value) => sum + value, 0) - visibleWidths.length - 2);
    const queueWidths = [...visibleWidths, titleWidth];
    const queueBorder = (left: string, join: string, right: string) => line(`${left}${queueWidths.map(size => "─".repeat(size)).join(join)}${right}`, "gray");
    const row = (pos: string, state: string, aheadCount: string, eta: string, title: string, tone: TerminalColor) => {
      const values: Array<[string, number, TerminalColor]> = [];
      if (positionWidth) values.push([pos, positionWidth, "gray"]);
      if (stateWidth) values.push([state, stateWidth, tone]);
      if (aheadWidth) values.push([aheadCount, aheadWidth, "yellow"]);
      if (etaWidth) values.push([eta, etaWidth, "magenta"]);
      values.push([title, titleWidth, "cyan"]);
      return `│${values.map(([text, size, cellTone]) => color(terminalCell(text, size), cellTone, colors)).join("│")}│`;
    };
    lines.push(queueBorder("┌", "┬", "┐"));
    lines.push(bold(row("POS", "STATE", "AHEAD", "START IN", "TASK", "cyan"), colors));
    lines.push(queueBorder("├", "┼", "┤"));
    if (!waiting.length) lines.push(line("  No other queued tasks."));
    for (const { item, ahead, eta } of rowData) lines.push(row(String(item.position ?? "-"), item.state, ahead, eta, item.title, stateColor(item.state)));
    lines.push(queueBorder("└", "┴", "┘"));
  }
  return [lines[0], ...lines.slice(1 + offset)].join("\n");
}

async function snapshot(workspace?: string): Promise<WatchSection[]> {
  const [registrations, persisted] = await Promise.all([loadRegistrations(), discoverPersistedQueueStatuses(queueStateDirectory())]);
  const visiblePersisted = visiblePersistedQueues(persisted, registrations);
  if (workspace) {
    const selectedPersisted = persisted.find(queue => queue.workspace === workspace);
    if (selectedPersisted && !visiblePersisted.some(queue => queue.workspace === workspace)) visiblePersisted.push(selectedPersisted);
  }
  const sections = new Map<string, WatchSection>(visiblePersisted
    .map(q => [q.workspace, { workspace: q.workspace, queue: reconcileQueueStatus(q, false), error: "Offline: persisted queue (not live)" }]));
  await Promise.all(registrations.map(async registration => {
    try {
      // Direct read-only IPC: deliberately bypass invoke's automatic recovery/restart.
      const [queueResponse, activityResponse] = await Promise.all([
        requestOverSocket(registration.socketPath, makeRequest("queueStatus", registration.workspace), COMPANION_POLL_TIMEOUT_MS),
        requestOverSocket(registration.socketPath, makeRequest("activity", registration.workspace), COMPANION_POLL_TIMEOUT_MS)
      ]);
      if (!queueResponse.ok) throw new Error("Queue status unavailable");
      const activity = activityResponse.ok ? activityResponse.result as WatchActivity : undefined;
      const queue = reconcileQueueStatus(queueResponse.result as QueueStatus, true, activity);
      lastLiveQueues.set(registration.workspace, queue);
      consecutiveCompanionFailures.delete(registration.workspace);
      companionFailureSince.delete(registration.workspace);
      sections.set(registration.workspace, { workspace: registration.workspace, queue, activity });
    } catch {
      const failures = (consecutiveCompanionFailures.get(registration.workspace) ?? 0) + 1;
      consecutiveCompanionFailures.set(registration.workspace, failures);
      const failedSince = companionFailureSince.get(registration.workspace) ?? Date.now();
      companionFailureSince.set(registration.workspace, failedSince);
      const cached = lastLiveQueues.get(registration.workspace) ?? sections.get(registration.workspace)?.queue;
      sections.set(registration.workspace, {
        workspace: registration.workspace,
        queue: cached,
        ...(shouldWarnCompanionFailure(failures, failedSince)
          ? { error: `Unavailable: companion has not answered for at least ${Math.floor((Date.now() - failedSince) / 1000)}s (${failures} polls); showing last known state` }
          : {})
      });
    }
  }));
  const result = [...sections.values()]
    .filter(section => hasActiveQueue(section.queue))
    .sort((a, b) => a.workspace.localeCompare(b.workspace));
  if (!workspace) return result;
  const selected = result.filter(section => section.workspace === workspace);
  const peers = result.filter(section => section.workspace !== workspace);
  return selected.map(section => ({ ...section, modelPeers: peers }));
}

export async function runWatch(selection?: string): Promise<number> {
  const workspace = selection ? await fs.realpath(path.resolve(selection)) : undefined;
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY && process.env.TERM !== "dumb");
  if (!interactive) { process.stdout.write(renderWatch(await snapshot(workspace)) + "\n"); return 0; }
  let stopped = false, offset = 0;
  let wakeRefresh: (() => void) | undefined;
  const watchers: FSWatcher[] = [];
  const wasRaw = process.stdin.isRaw;
  const refresh = () => { const wake = wakeRefresh; wakeRefresh = undefined; wake?.(); };
  const stop = () => { stopped = true; refresh(); };
  const input = (data: Buffer) => {
    const key = data.toString();
    if (key === "q" || key === "\x03") stop();
    else if (key === "j" || key === "\x1b[B") { offset++; refresh(); }
    else if (key === "k" || key === "\x1b[A") { offset = Math.max(0, offset - 1); refresh(); }
  };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  process.on("SIGWINCH", refresh);
  process.stdin.on("data", input);
  try {
    for (const directory of new Set([runtimeDirectory(), queueStateDirectory()])) {
      try { watchers.push(watchFs(directory, { persistent: false }, refresh)); }
      catch { /* The periodic refresh also discovers directories created later. */ }
    }
    process.stdin.setRawMode(true); process.stdin.resume();
    // The title is also an explicit contract with terminal cleanup: monitoring
    // terminals are user-owned, long-lived views and must never be garbage-collected.
    process.stdout.write(watchTerminalTitleSequence() + "\x1b[?1049h\x1b[?25l");
    while (!stopped) {
      let frame: string;
      try { frame = renderWatch(await snapshot(workspace), process.stdout.columns || 100, supportsColor(), offset); }
      catch { frame = "CLINE CONSOLE | Status unavailable; retrying. q to exit"; }
      if (stopped) break;
      process.stdout.write("\x1b[H\x1b[2J" + frame.split("\n").slice(0, Math.max(1, (process.stdout.rows || 24) - 1)).join("\n"));
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { if (wakeRefresh === wake) wakeRefresh = undefined; resolve(); }, 2_000);
        const wake = () => { clearTimeout(timer); resolve(); };
        wakeRefresh = wake;
      });
    }
  } finally {
    for (const watcher of watchers) watcher.close();
    process.stdin.off("data", input); process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("SIGWINCH", refresh);
    process.stdin.setRawMode(wasRaw); process.stdin.pause();
    process.stdout.write("\x1b[0m\x1b[?25h\x1b[?1049l" + watchTerminalTitleSequence(""));
  }
  return 0;
}
