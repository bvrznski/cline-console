# Flow Principles and State Machine

## Overview

This document describes the flow principles and state machine for cline-console task queue processing.

## Core Flow Principles

### 1. Task Lifecycle States

Tasks transition through the following states:

```
queued → running → completed/failed/skipped
```

### 2. Child Task Spawning

When Cline reports `status === "completed"` with a **different session ID** than the current item, it indicates a new task was spawned:

```typescript
// Child task spawning: when a new task is spawned via newTask,
// the parent queue item's session is replaced and its completion
// results in immediate completion of the parent process.
if (result.status === "completed" && result.sessionId !== item.sessionId) {
  this.logger.info(`Child task ${result.sessionId} spawned from parent task ${item.id}; marking parent as completed.`);
  item.sessionId = result.sessionId;
  item.finishedAt = new Date().toISOString();
  item.state = queueStateTransition(item.state, "completed");
  await this.persist();
  continue; // Continue to next queued task
}
```

- The child task inherits the parent's scope and context
- The parent queue item is immediately marked as completed
- The queue can then progress to the next queued task without additional verification

### 3. Completion verification

When Cline reports `status === "completed"` with the same session ID:

```typescript
if (this.scanner.enabled && this.scanner.verifyCompletionCriteria && item.kind !== "message" && result.status === "completed") {
  // Request once, repeat after implementation, and accept only a newer
  // verification completion with no implementation activity.
}
```

- The initial completion receives a same-thread verification request.
- A verification pass that changes implementation is verified again.
- A newer read-only verification completion permits queue completion.
- Explicit CLI `DONE` is the only user-confirmed bypass.

### 4. Queue Continuity

The queue maintains continuity through:
- **Dispatch stability**: Waits for workspace idle before dispatching new tasks
- **Inter-task delay**: Configurable delay between task completions
- **Error recovery**: Failed tasks are marked and queue continues with next item

## State Machine

### Persistent Queue States

```typescript
type PersistentQueueState = "queued" | "running" | "completed" | "failed" | "skipped"
```

### Allowed State Transitions

| Current State | Allowed Next States |
|---------------|---------------------|
| queued        | running             |
| running       | queued, completed, failed, skipped |
| completed     | (terminal)          |
| failed        | (terminal)          |
| skipped       | (terminal)          |

### Queue Item State Transitions

```
┌─────────┐
│  queued │ ──────► ───────►  running  ───────►  completed
└─────────┘                     │  ▲           (terminal)
                                │  │           (userConfirmedCompletion)
                                │  │
                                │  └──────►  failed
                                │              (terminal)
                                │
                                └───────────►  skipped
                                               (terminal)
```

### Task Completion States

Cline can report the following completion statuses:

| Status | Action |
|--------|--------|
| `completed` | Mark task as completed, queue continues |
| `context_overflow` | Request compaction, continue in same thread |
| `task_failed` | Request compaction, may restart on YOLO failure |
| `test_timeout` | Block completion until timeout is resolved |
| `scope_violation` | Enforce scope restrictions |
| `deleted` | Pause queue without advancing |

## Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Queue Worker Loop                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────────┐
              │  Wait for workspace idle          │
              │  (if paused, return)              │
              └───────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────────┐
              │  Find next queued task            │
              │  (if none, return)                │
              └───────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────────┐
              │  Dispatch task to Cline           │
              │  state: queued → running          │
              └───────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────────┐
              │  Monitor task completion          │
              │  - context_overflow → compact     │
              │  - task_failed → retry/continue   │
              │  - test_timeout → resolve         │
              │  - scope_violation → enforce      │
              │  - completed (same session)       │
              │    → immediate flag, no verify   │
              │  - completed (new session)        │
              │    → child task spawned, parent  │
              │      marked completed            │
              └───────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────────┐
              │  Update task state                │
              │  - completed → completed          │
              │  - failed → failed                │
              │  - deleted → pause queue          │
              └───────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────────┐
              │  Continue to next task            │
              └───────────────────────────────────┘
```

## Key Behaviors

### 1. Completion Verification (Same Session)

When `result.status === "completed"` and `result.sessionId === item.sessionId`:

```typescript
await this.adapter.sendMessage(completionVerificationFollowup(false));
item.completionVerificationRequested = true;
item.lastCompletionMarker = result.completionMarker;
await this.persist();
```

- The task remains running while verification is pending.
- Implementation during verification triggers another verification request.
- A newer verification response without implementation changes passes the gate.

### 2. Child Task Spawning (New Session)

When `result.status === "completed"` and `result.sessionId !== item.sessionId`:

```typescript
// Child task spawned - parent marked completed immediately
item.sessionId = result.sessionId;
item.finishedAt = new Date().toISOString();
item.state = queueStateTransition(item.state, "completed");
await this.persist();
continue; // Continue to next queued task
```

- A new Cline session was created (child task)
- Parent queue item is marked as completed immediately
- Queue continues without additional verification

### 3. Error Recovery

Failed tasks are handled by:
1. Marking the task as `failed`
2. Recording error details
3. Continuing with next queued task
4. Optionally requesting workspace restart for YOLO failures

## State Transition Validation

The `queueStateTransition` function validates state transitions:

```typescript
export function queueStateTransition(current: PersistentQueueState, next: PersistentQueueState): PersistentQueueState {
  if (current === next) return next;
  if (ALLOWED_TRANSITIONS[current].includes(next)) return next;
  throw new Error(`Invalid persisted queue transition: ${current} -> ${next}`);
}
```

## History Recording

All state transitions are recorded in the SQLite history database with event types:
- `queue_task_dispatched`
- `cline_task_observation`
- `completion_verification_requested`
- `completion_reverification_requested`
- `completion_verified`
- `task_failed`
- `queue_task_interrupted`
