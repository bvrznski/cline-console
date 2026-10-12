import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { ClineConsoleError, errorMessage } from "../common/errors";
import type { Logger } from "../common/logging";
import { makeRequest, MAX_MESSAGE_BYTES, MAX_MESSAGE_MIB, parseRequest, serializeResponse } from "../ipc/protocol";
import { requestOverSocket } from "../ipc/transport";
import type { IpcResponse, WorkspaceRegistration } from "../ipc/types";
import { loadRegistrations, waitForWorkspaceRegistration } from "../client/ipc_client";
import type { WorkspaceActivity } from "../integrations/cline/completion_monitor";
import { ensureRuntimeDirectory, queueStateDirectory, queueStatePath, registrationPath, runtimeDirectory, workspaceId } from "../extension/workspace_registry";
import { HistoryStore } from "../history/history_store";
import { openWorkspaceWindow, restartExtension } from "../extension/hangup_detector";
import { discoverPersistedQueueStatuses, TASK_DISPATCH_DELAY_MS } from "../extension/task_queue";
import { parseYoloRestartRequest, type YoloRestartRequest } from "./restart_request";

export function serviceSocketPath(directory = runtimeDirectory()): string { return path.join(directory, "service.sock"); }

export interface ModelQueueObservation extends WorkspaceActivity {
  workspace: string;
  socketPath: string;
}

interface PreemptedModelQueue {
  workspace: string;
  sessionId: string;
}

interface RestartLeaseProtection {
  sessionId: string;
  until: number;
}

export const YOLO_RESTART_LEASE_GRACE_MS = 2 * 60_000;
export const UNEXPECTED_CLOSE_GRACE_MS = 15_000;
export const UNEXPECTED_CLOSE_REOPEN_COOLDOWN_MS = 60_000;

export function unexpectedlyClosedQueueWorkspaces(
  queues: ReadonlyArray<{ workspace: string; queueLength: number; paused?: boolean }>,
  registrations: ReadonlyArray<Pick<WorkspaceRegistration, "workspace">>
): string[] {
  const connected = new Set(registrations.map(value => path.resolve(value.workspace)));
  return queues.filter(value => value.queueLength > 0 && value.paused !== true && !connected.has(path.resolve(value.workspace))).map(value => value.workspace);
}

export function restartLeaseActive(
  protection: RestartLeaseProtection | undefined,
  observation: Pick<ModelQueueObservation, "status"> | undefined,
  now = Date.now()
): boolean {
  return protection !== undefined && protection.until > now && observation?.status !== "running";
}

export function selectModelQueueWinner(
  running: ModelQueueObservation[],
  currentOwner: { workspace: string; sessionId: string } | undefined,
  previousRunningSessions: ReadonlyMap<string, string>
): ModelQueueObservation | undefined {
  const transitioned = running.filter(value => value.sessionId && previousRunningSessions.get(value.workspace) !== value.sessionId);
  if (transitioned.length) return latestModelObservation(transitioned);
  const retained = currentOwner && running.find(value => value.workspace === currentOwner.workspace && value.sessionId === currentOwner.sessionId);
  return retained ?? latestModelObservation(running);
}

export function modelRestorationReady(releasedAt: number | undefined, now = Date.now(), delayMs = TASK_DISPATCH_DELAY_MS): boolean {
  return releasedAt !== undefined && now - releasedAt >= delayMs;
}

/** A terminal completion claim is not a released model while its queue is
 * still auditing or delivering follow-up work.  A waiting state, however, is
 * an explicit manual Cancel boundary and must yield to another resumed queue. */
export function modelLeaseOccupied(observation: Pick<ModelQueueObservation, "status" | "queueActive"> | undefined): boolean {
  return observation?.status === "running"
    || observation?.queueActive === true && (observation.status === "completed" || observation.status === "idle");
}

export function updatePreviousRunningSessions(
  previous: ReadonlyMap<string, string>,
  observations: ReadonlyArray<Pick<ModelQueueObservation, "workspace" | "status" | "sessionId">>
): Map<string, string> {
  const next = new Map(previous);
  for (const observation of observations) {
    if (observation.status === "running" && observation.sessionId) next.set(observation.workspace, observation.sessionId);
    else next.delete(observation.workspace);
  }
  return next;
}

function latestModelObservation(values: ModelQueueObservation[]): ModelQueueObservation | undefined {
  return [...values].sort((left, right) => observationTime(right) - observationTime(left) || right.workspace.localeCompare(left.workspace))[0];
}

function observationTime(value: ModelQueueObservation): number {
  const parsed = value.observedAt ? Date.parse(value.observedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export class ClineConsoleService {
  private server?: net.Server;
  readonly socketPath: string;
  private readonly directory: string;
  private recoveryWorker?: Promise<void>;
  private recoveryAbort = new AbortController();
  private readonly modelOwners = new Map<string, { workspace: string; sessionId: string }>();
  private readonly previousRunningSessions = new Map<string, string>();
  private readonly preemptionsInFlight = new Set<string>();
  private readonly observedWorkspaces = new Set<string>();
  private readonly preemptedModelQueues = new Map<string, PreemptedModelQueue[]>();
  private readonly modelReleasedAt = new Map<string, number>();
  private readonly restartLeaseProtections = new Map<string, RestartLeaseProtection>();
  private readonly preferredWorkspaceByModel = new Map<string, { workspace: string; until: number }>();
  private readonly missingWorkspaceSince = new Map<string, number>();
  private readonly workspaceReopenAttemptedAt = new Map<string, number>();
  private readonly workspaceReopensInFlight = new Set<string>();

  private readonly legacyRequestDirectory?: string;

  constructor(private readonly logger: Logger, directory = runtimeDirectory(), legacyRequestDirectory?: string) {
    this.directory = directory;
    this.socketPath = serviceSocketPath(directory);
    this.legacyRequestDirectory = legacyRequestDirectory ?? (directory === runtimeDirectory() ? queueStateDirectory() : undefined);
  }

  async start(): Promise<void> {
    await ensureRuntimeDirectory(path.dirname(this.socketPath));
    const recovered = await recoverRestartArtifacts(this.directory);
    const removedLegacy = this.legacyRequestDirectory && this.legacyRequestDirectory !== this.directory
      ? await removeExpiredRestartArtifacts(this.legacyRequestDirectory) : 0;
    if (recovered) this.logger.info(`Recovered ${recovered} abandoned YOLO restart request(s).`);
    if (removedLegacy) this.logger.info(`Removed ${removedLegacy} expired YOLO restart artifact(s) from legacy queue storage.`);
    await this.removeStaleSocket();
    this.server = net.createServer(socket => this.handle(socket));
    this.server.on("error", error => this.logger.error(`Service error: ${errorMessage(error)}`));
    try {
      await new Promise<void>((resolve, reject) => this.server!.listen(this.socketPath, resolve).once("error", reject));
      await fs.chmod(this.socketPath, 0o600);
      this.logger.info(`Singleton service listening on ${this.socketPath} (pid ${process.pid}).`);
      this.recoveryWorker = this.monitorRestartRequests();
    } catch (error) {
      this.server = undefined;
      throw error;
    }
  }

  private async removeStaleSocket(): Promise<void> {
    try {
      const stat = await fs.lstat(this.socketPath);
      if (!stat.isSocket()) throw new ClineConsoleError("UNSAFE_SERVICE_PATH", `Refusing to replace non-socket path: ${this.socketPath}`);
      if (await probeService(this.socketPath)) throw new ClineConsoleError("SERVICE_ALREADY_RUNNING", "A cline-console service instance is already running.");
      await fs.unlink(this.socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private handle(socket: net.Socket): void {
    socket.setTimeout(30_000, () => socket.destroy());
    let data = Buffer.alloc(0), handled = false;
    socket.on("data", chunk => {
      if (handled) return;
      data = Buffer.concat([data, chunk]);
      if (data.length > MAX_MESSAGE_BYTES) { handled = true; this.writeError(socket, "unknown", new ClineConsoleError("REQUEST_TOO_LARGE", `Service request exceeds ${MAX_MESSAGE_MIB} MiB.`)); return; }
      const newline = data.indexOf(10);
      if (newline < 0) return;
      handled = true;
      this.route(socket, data.subarray(0, newline).toString("utf8")).catch(error => this.writeError(socket, "unknown", error));
    });
    socket.on("error", error => this.logger.debug(`Service client disconnected: ${errorMessage(error)}`));
  }

  private async route(socket: net.Socket, line: string): Promise<void> {
    let request;
    try { request = parseRequest(line); } catch (error) { this.writeError(socket, "unknown", error); return; }
    try {
      if (request.action === "enqueueContext") {
        const result = await readEnqueueContext(queueStatePath(request.workspace), request.workspace);
        socket.end(serializeResponse({ protocolVersion: 1, requestId: request.requestId, ok: true, result }));
        return;
      }
      if (request.action === "continueQueue" || request.action === "relaunchQueue") {
        const existing = await waitForWorkspaceRegistration(request.workspace, request.workspace, this.directory, 500).catch(() => undefined);
        if (!existing) {
          this.logger.info(`Opening unavailable workspace ${request.workspace} for ${request.action}.`);
          await openWorkspaceWindow(request.workspace, 45_000, this.directory);
        }
      }
      const registration = await waitForWorkspaceRegistration(request.workspace, request.workspace, this.directory);
      this.logger.info(`Routing ${request.action} request ${request.requestId} to ${registration.workspace}.`);
      const response = await requestOverSocket(registration.socketPath, request, 30_000);
      if (request.action === "resumeQueue" && response.ok) {
        await this.preferResumedWorkspace(registration).catch(error => this.logger.error(`Explicit queue takeover failed safely for ${registration.workspace}: ${errorMessage(error)}`));
      }
      socket.end(serializeResponse(response));
    } catch (error) { this.writeError(socket, request.requestId, error); }
  }

  private writeError(socket: net.Socket, requestId: string, error: unknown): void {
    const code = error instanceof ClineConsoleError ? error.code : "SERVICE_ERROR";
    const response: IpcResponse = { protocolVersion: 1, requestId, ok: false, error: { code, message: errorMessage(error) } };
    this.logger.error(`${code}: ${errorMessage(error)}`);
    socket.end(serializeResponse(response));
  }

  private async monitorRestartRequests(): Promise<void> {
    while (!this.recoveryAbort.signal.aborted) {
      try {
        const names = await fs.readdir(this.directory);
        for (const name of names.filter(value => /^restart-[0-9a-f-]+\.json$/.test(value))) await this.handleRestartRequest(path.join(this.directory, name));
        await this.arbitrateLmStudioQueues();
        await this.detectUnexpectedlyClosedWorkspaces();
      } catch (error) {
        if (!this.recoveryAbort.signal.aborted) this.logger.error(`YOLO restart monitor failed safely: ${errorMessage(error)}`);
      }
      await abortableDelay(1_000, this.recoveryAbort.signal);
    }
  }

  private async detectUnexpectedlyClosedWorkspaces(): Promise<void> {
    const [registrations, queues] = await Promise.all([
      loadRegistrations(this.directory),
      discoverPersistedQueueStatuses(queueStateDirectory())
    ]);
    const missing = new Set(unexpectedlyClosedQueueWorkspaces(queues, registrations));
    const now = Date.now();
    for (const workspace of [...this.missingWorkspaceSince.keys()]) {
      if (!missing.has(workspace)) {
        this.missingWorkspaceSince.delete(workspace);
        this.workspaceReopenAttemptedAt.delete(workspace);
      }
    }
    for (const workspace of missing) {
      const since = this.missingWorkspaceSince.get(workspace);
      if (since === undefined) { this.missingWorkspaceSince.set(workspace, now); continue; }
      if (now - since < UNEXPECTED_CLOSE_GRACE_MS || this.workspaceReopensInFlight.has(workspace)) continue;
      const attemptedAt = this.workspaceReopenAttemptedAt.get(workspace) ?? 0;
      if (now - attemptedAt < UNEXPECTED_CLOSE_REOPEN_COOLDOWN_MS) continue;
      this.workspaceReopenAttemptedAt.set(workspace, now);
      this.workspaceReopensInFlight.add(workspace);
      this.recordWorkspaceRecoveryEvent(workspace, "workspace_unexpectedly_closed_detected", { missingForMs: now - since });
      void openWorkspaceWindow(workspace, 45_000, this.directory).then(registration => {
        this.recordWorkspaceRecoveryEvent(workspace, "workspace_automatically_reopened", { pid: registration.pid });
        this.logger.info(`Automatically reopened unexpectedly closed VS Code workspace ${workspace}.`);
      }).catch(error => {
        this.recordWorkspaceRecoveryEvent(workspace, "workspace_automatic_reopen_failed", { error: errorMessage(error) });
        this.logger.error(`Automatic workspace reopen failed for ${workspace}: ${errorMessage(error)}`);
      }).finally(() => this.workspaceReopensInFlight.delete(workspace));
    }
  }

  private recordWorkspaceRecoveryEvent(workspace: string, type: string, payload: Record<string, unknown>): void {
    let history: HistoryStore | undefined;
    try {
      history = new HistoryStore();
      history.recordEvent(workspace, { type, source: "cline-console", observed: true, payload });
    } catch (error) { this.logger.error(`Failed to record workspace recovery event: ${errorMessage(error)}`); }
    finally { history?.close(); }
  }

  private async arbitrateLmStudioQueues(): Promise<void> {
    const registrations = await loadRegistrations(this.directory);
    const observations = (await Promise.all(registrations.map(registration => this.readModelObservation(registration))))
      .filter((value): value is ModelQueueObservation => value !== undefined);
    const running = observations.filter(value => value.status === "running" && value.sessionId && value.modelIdentity);
    const now = Date.now();
    for (const [workspace, protection] of this.restartLeaseProtections) {
      const observation = observations.find(value => value.workspace === workspace);
      if (!restartLeaseActive(protection, observation, now)) this.restartLeaseProtections.delete(workspace);
    }
    for (const observation of observations) {
      const conflict = observation.modelConflict;
      if (!conflict || !observation.sessionId) continue;
      const suspended = this.preemptedModelQueues.get(conflict.modelIdentity) ?? [];
      if (!suspended.some(value => value.workspace === observation.workspace && value.sessionId === observation.sessionId)) {
        suspended.push({ workspace: observation.workspace, sessionId: observation.sessionId });
        this.preemptedModelQueues.set(conflict.modelIdentity, suspended);
        this.logger.info(`Recovered durable model preemption for ${observation.sessionId} in ${observation.workspace}.`);
      }
    }
    const groups = new Map<string, ModelQueueObservation[]>();
    for (const observation of running) {
      const group = groups.get(observation.modelIdentity!) ?? [];
      group.push(observation);
      groups.set(observation.modelIdentity!, group);
    }

    for (const [modelIdentity, group] of groups) {
      this.modelReleasedAt.delete(modelIdentity);
      const currentOwner = this.modelOwners.get(modelIdentity);
      const ownerObservation = currentOwner ? observations.find(value => value.workspace === currentOwner.workspace) : undefined;
      if (currentOwner && restartLeaseActive(this.restartLeaseProtections.get(currentOwner.workspace), ownerObservation, now)) {
        this.logger.debug(`Preserving LM Studio model ${modelIdentity} for ${currentOwner.workspace} during YOLO restart recovery.`);
        continue;
      }
      const preference = this.preferredWorkspaceByModel.get(modelIdentity);
      if (preference && preference.until <= now) this.preferredWorkspaceByModel.delete(modelIdentity);
      const preferred = preference && preference.until > now ? group.find(value => value.workspace === preference.workspace) : undefined;
      const winner = preferred ?? selectModelQueueWinner(group, currentOwner, this.previousRunningSessions);
      if (!winner?.sessionId) continue;
      const resumedInCline = this.observedWorkspaces.has(winner.workspace)
        && this.previousRunningSessions.get(winner.workspace) !== winner.sessionId;
      this.modelOwners.set(modelIdentity, { workspace: winner.workspace, sessionId: winner.sessionId });
      for (const loser of group.filter(value => value.workspace !== winner.workspace || value.sessionId !== winner.sessionId)) {
        await this.preemptModelCompetitor(loser, winner, modelIdentity);
      }
      if (resumedInCline) await this.resumeModelWinnerQueue(winner, modelIdentity);
    }

    const trackedIdentities = new Set([...this.modelOwners.keys(), ...this.preemptedModelQueues.keys()]);
    for (const identity of trackedIdentities) {
      if (groups.has(identity)) continue;
      const owner = this.modelOwners.get(identity);
      const ownerObservation = owner ? observations.find(value => value.workspace === owner.workspace) : undefined;
      if (owner && restartLeaseActive(this.restartLeaseProtections.get(owner.workspace), ownerObservation, now)) {
        this.modelReleasedAt.delete(identity);
        continue;
      }
      const candidate = this.preemptedModelQueues.get(identity)?.at(-1);
      const winnerWorkspace = owner?.workspace ?? observations.find(value => value.workspace === candidate?.workspace)?.modelConflict?.winnerWorkspace;
      const winnerObservation = winnerWorkspace ? observations.find(value => value.workspace === winnerWorkspace) : undefined;
      if (!winnerObservation || modelLeaseOccupied(winnerObservation)) continue;
      const releasedAt = this.modelReleasedAt.get(identity);
      if (releasedAt === undefined) {
        this.modelReleasedAt.set(identity, Date.now());
        this.logger.info(`LM Studio model ${identity} released; waiting ${TASK_DISPATCH_DELAY_MS / 1_000} seconds before restoring a preempted queue.`);
        continue;
      }
      if (!modelRestorationReady(releasedAt)) continue;
      if (await this.restorePreemptedModelQueue(identity, registrations)) this.modelOwners.delete(identity);
      else if (!(this.preemptedModelQueues.get(identity)?.length)) this.modelOwners.delete(identity);
      if (!this.modelOwners.has(identity)) this.modelReleasedAt.delete(identity);
    }
    const currentlyRunning = new Set(running.map(value => `${value.workspace}\0${value.sessionId}`));
    for (const key of [...this.preemptionsInFlight]) if (!currentlyRunning.has(key)) this.preemptionsInFlight.delete(key);
    const updatedPrevious = updatePreviousRunningSessions(this.previousRunningSessions, observations);
    this.previousRunningSessions.clear();
    for (const [workspace, sessionId] of updatedPrevious) this.previousRunningSessions.set(workspace, sessionId);
    for (const observation of observations) this.observedWorkspaces.add(observation.workspace);
  }

  private async readModelObservation(registration: WorkspaceRegistration): Promise<ModelQueueObservation | undefined> {
    try {
      const response = await requestOverSocket(registration.socketPath, makeRequest("activity", registration.workspace), 2_500);
      if (!response.ok || !response.result || typeof response.result !== "object") return undefined;
      const activity = response.result as WorkspaceActivity;
      return { workspace: registration.workspace, socketPath: registration.socketPath, ...activity };
    } catch (error) {
      this.logger.debug(`Model arbitration skipped unavailable workspace ${registration.workspace}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** An explicit `queue resume` is an operator override: the selected workspace
   * wins its shared LM Studio lease and competing queue work is interrupted. */
  private async preferResumedWorkspace(registration: WorkspaceRegistration): Promise<void> {
    const target = await this.readModelObservation(registration);
    const modelIdentity = target?.modelIdentity ?? target?.modelConflict?.modelIdentity;
    if (!target || !modelIdentity) return;
    this.preferredWorkspaceByModel.set(modelIdentity, { workspace: target.workspace, until: Date.now() + 60_000 });
    const registrations = await loadRegistrations(this.directory);
    const observations = (await Promise.all(registrations.map(value => this.readModelObservation(value))))
      .filter((value): value is ModelQueueObservation => value !== undefined);
    const winner: ModelQueueObservation = { ...target, modelIdentity };
    for (const loser of observations.filter(value => value.workspace !== target.workspace && value.status === "running" && value.modelIdentity === modelIdentity)) {
      await this.preemptModelCompetitor(loser, winner, modelIdentity);
    }
    if (!target.modelConflict || !target.sessionId) return;
    await abortableDelay(TASK_DISPATCH_DELAY_MS, this.recoveryAbort.signal);
    const response = await requestOverSocket(registration.socketPath, makeRequest("resumePreemptedQueueTask", target.workspace, {
      sessionId: target.sessionId,
      modelIdentity
    }), 30_000);
    if (!response.ok) throw new Error(response.error?.message ?? "Selected workspace rejected queue takeover.");
    const suspended = this.preemptedModelQueues.get(modelIdentity);
    if (suspended) {
      const index = suspended.findIndex(value => value.workspace === target.workspace && value.sessionId === target.sessionId);
      if (index >= 0) suspended.splice(index, 1);
      if (!suspended.length) this.preemptedModelQueues.delete(modelIdentity);
    }
    this.logger.info(`Explicit queue resume transferred LM Studio model ${modelIdentity} to ${target.workspace}.`);
  }

  private async preemptModelCompetitor(loser: ModelQueueObservation, winner: ModelQueueObservation, modelIdentity: string): Promise<void> {
    if (!loser.sessionId) return;
    const key = `${loser.workspace}\0${loser.sessionId}`;
    if (this.preemptionsInFlight.has(key)) return;
    this.preemptionsInFlight.add(key);
    try {
      const response = await requestOverSocket(loser.socketPath, makeRequest("preemptQueueTask", loser.workspace, {
        sessionId: loser.sessionId,
        winnerWorkspace: winner.workspace,
        modelIdentity
      }), 10_000);
      if (!response.ok) throw new Error(response.error?.message ?? "Competing workspace rejected model preemption.");
      const suspended = this.preemptedModelQueues.get(modelIdentity) ?? [];
      if (!suspended.some(value => value.workspace === loser.workspace && value.sessionId === loser.sessionId)) {
        suspended.push({ workspace: loser.workspace, sessionId: loser.sessionId });
        this.preemptedModelQueues.set(modelIdentity, suspended);
      }
      this.logger.info(`Paused and interrupted queue task ${loser.sessionId} in ${loser.workspace} without leaving its Cline thread; ${winner.workspace} acquired LM Studio model ${modelIdentity}.`);
    } catch (error) {
      this.preemptionsInFlight.delete(key);
      this.logger.error(`LM Studio queue arbitration failed safely for ${loser.workspace}: ${errorMessage(error)}`);
    }
  }

  private async restorePreemptedModelQueue(modelIdentity: string, registrations: WorkspaceRegistration[]): Promise<boolean> {
    const suspended = this.preemptedModelQueues.get(modelIdentity);
    if (!suspended?.length) return false;
    // A closed workspace at the top of the LIFO list must not permanently
    // block an older, still-connected queue from reclaiming the model.
    for (let index = suspended.length - 1; index >= 0; index -= 1) {
      const candidate = suspended[index];
      const registration = registrations.find(value => value.workspace === candidate.workspace);
      if (!registration) {
        this.logger.debug(`Skipped offline preempted workspace ${candidate.workspace} while searching for a restorable queue.`);
        continue;
      }
      try {
        const resumeTask = await requestOverSocket(registration.socketPath, makeRequest("resumePreemptedQueueTask", candidate.workspace, { sessionId: candidate.sessionId, modelIdentity }), 30_000);
        if (!resumeTask.ok) throw new Error(resumeTask.error?.message ?? "Workspace rejected preempted task resume.");
        suspended.splice(index, 1);
        if (!suspended.length) this.preemptedModelQueues.delete(modelIdentity);
        this.logger.info(`Restored preempted queue task ${candidate.sessionId} in ${candidate.workspace} after LM Studio model ${modelIdentity} was released.`);
        return true;
      } catch (error) {
        this.logger.error(`LM Studio queue restoration failed safely for ${candidate.workspace}: ${errorMessage(error)}`);
      }
    }
    return false;
  }

  private async resumeModelWinnerQueue(winner: ModelQueueObservation, modelIdentity: string): Promise<void> {
    try {
      const response = await requestOverSocket(winner.socketPath, makeRequest("resumeQueue", winner.workspace), 5_000);
      if (!response.ok) throw new Error(response.error?.message ?? "Winning workspace rejected queue resume.");
      this.logger.info(`Resumed queue in ${winner.workspace} after its Cline task acquired LM Studio model ${modelIdentity}.`);
    } catch (error) {
      this.logger.error(`LM Studio winner queue resume failed safely for ${winner.workspace}: ${errorMessage(error)}`);
    }
  }

  private async handleRestartRequest(file: string): Promise<void> {
    const claimed = `${file}.processing`;
    try { await fs.rename(file, claimed); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    let request: YoloRestartRequest | undefined;
    try {
      request = parseYoloRestartRequest(JSON.parse(await fs.readFile(claimed, "utf8")));
      if (!request) throw new Error("Invalid YOLO restart request.");
      const id = workspaceId(request.workspace);
      const registration = JSON.parse(await fs.readFile(registrationPath(this.directory, id), "utf8")) as import("../ipc/types").WorkspaceRegistration;
      if (registration.workspace !== request.workspace || !Number.isSafeInteger(registration.pid)) throw new Error("No exact live workspace registration matches the restart request.");
      const pid = registration.pid!;
      const command = await readProcessCommand(pid);
      if (!isSafeCodeExtensionHostCommand(command)) throw new Error(`Refusing to terminate unverified process ${pid}.`);
      this.restartLeaseProtections.set(request.workspace, { sessionId: request.sessionId, until: Number.POSITIVE_INFINITY });
      this.recordRestartEvent(request, "yolo_daemon_restart_started", { pid, command });
      const replacement = await restartExtension(registration);
      this.restartLeaseProtections.set(request.workspace, { sessionId: request.sessionId, until: Date.now() + YOLO_RESTART_LEASE_GRACE_MS });
      this.recordRestartEvent(request, "yolo_daemon_restart_completed", { pid, replacementPid: replacement.pid, registeredAt: replacement.registeredAt });
      this.logger.info(`Recycled VS Code extension host ${pid} as verified host ${replacement.pid} for ${request.workspace} after YOLO failure ${request.failureMarker}.`);
    } catch (error) {
      if (request) this.restartLeaseProtections.delete(request.workspace);
      if (request) this.recordRestartEvent(request, "yolo_daemon_restart_failed", { error: errorMessage(error) });
      this.logger.error(`YOLO workspace restart failed safely: ${errorMessage(error)}`);
    } finally {
      await fs.unlink(claimed).catch(() => undefined);
    }
  }

  private recordRestartEvent(request: YoloRestartRequest, type: string, payload: Record<string, unknown>): void {
    let history: HistoryStore | undefined;
    try {
      history = new HistoryStore();
      history.recordEvent(request.workspace, { type, source: "cline-console", observed: true, taskId: request.queueItemId, queueItemId: request.queueItemId, clineSessionId: request.sessionId, payload: { requestId: request.id, failureMarker: request.failureMarker, errorText: request.errorText, requestedAt: request.requestedAt, ...payload } });
    } catch (error) { this.logger.error(`Failed to record YOLO restart event in SQLite: ${errorMessage(error)}`); }
    finally { history?.close(); }
  }

  async stop(): Promise<void> {
    this.recoveryAbort.abort();
    await this.recoveryWorker;
    this.recoveryWorker = undefined;
    const server = this.server;
    this.server = undefined;
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.unlink(this.socketPath).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    this.logger.info("Singleton service stopped.");
  }
}

export async function readEnqueueContext(file: string, workspace: string): Promise<{ active: boolean; sessionId?: string; status: "running" | "idle" }> {
  const value = JSON.parse(await fs.readFile(file, "utf8")) as {
    workspace?: string;
    items?: Array<{ state?: string; sessionId?: string }>;
  };
  if (value.workspace !== workspace || !Array.isArray(value.items)) throw new ClineConsoleError("QUEUE_UNAVAILABLE", "Persisted queue state is unavailable.");
  const current = value.items.find(item => item.state === "running");
  return current ? { active: true, sessionId: current.sessionId, status: "running" } : { active: false, status: "idle" };
}

export function isSafeCodeExtensionHostCommand(command: string): boolean {
  return /(?:^|\/)code(?:\s|$)/.test(command) && command.includes("--type=utility") && command.includes("node.mojom.NodeService");
}

const RESTART_REQUEST = /^restart-[0-9a-f-]+\.json$/;
const CLAIMED_RESTART_REQUEST = /^restart-[0-9a-f-]+\.json\.processing$/;

export async function recoverRestartArtifacts(directory: string, now = Date.now(), leaseMs = 30_000): Promise<number> {
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let recovered = 0;
  for (const name of names.filter(value => CLAIMED_RESTART_REQUEST.test(value))) {
    const claimed = path.join(directory, name), target = claimed.slice(0, -".processing".length);
    const stat = await fs.stat(claimed).catch(() => undefined);
    if (!stat || now - stat.mtimeMs < leaseMs) continue;
    const targetExists = await fs.stat(target).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    if (targetExists) { await fs.unlink(claimed); continue; }
    try {
      await fs.rename(claimed, target);
      recovered += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await fs.unlink(claimed);
    }
  }
  return recovered;
}

export async function removeExpiredRestartArtifacts(directory: string, now = Date.now(), maxAgeMs = 10 * 60_000): Promise<number> {
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
  let removed = 0;
  for (const name of names.filter(value => RESTART_REQUEST.test(value) || CLAIMED_RESTART_REQUEST.test(value))) {
    const file = path.join(directory, name);
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat || now - stat.mtimeMs < maxAgeMs) continue;
    await fs.unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
    removed += 1;
  }
  return removed;
}

async function readProcessCommand(pid: number): Promise<string> { return (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim(); }
function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export async function probeService(socketPath = serviceSocketPath(), timeoutMs = 750): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}
