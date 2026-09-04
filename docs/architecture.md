# Architecture

## Purpose

Cline Console is a local control plane for the Cline extension already running
inside VS Code. It does not implement an agent, call a model provider directly,
or replace Cline's task runtime.

```text
terminal CLI
    -> singleton user service
        -> exact workspace registration and Unix socket
            -> Cline Console companion extension
                -> Cline public activation API
                    -> normal Cline task, history, approvals, and UI
```

## Components

The CLI parses input, selects a registered workspace, and sends one versioned
newline-delimited JSON request. It does not connect directly to arbitrary VS
Code processes.

The singleton user service owns the stable local endpoint and routes each
request to the companion socket registered by the exact canonical workspace
path. Only one service process may own its Unix socket.

Each companion extension instance owns its workspace adapter and persistent
FIFO worker. It invokes Cline's public `startNewTask` and `sendMessage` API and
uses Cline's registered command for cancellation.

The compatibility adapter contains all Cline-version-specific behavior. Status
and queue completion use Cline's persisted task history because the Legacy API
does not export authoritative lifecycle state.

## State and persistence

- Registrations and queue files: `$XDG_RUNTIME_DIR/cline-console/`
- Service socket: `$XDG_RUNTIME_DIR/cline-console/service.sock`
- Log: `$XDG_STATE_HOME/cline-console/cline-console.log`
- User service: `~/.config/systemd/user/cline-console.service`
- Cline task history: owned and written by Cline under VS Code global storage

Queue entries contain prompt/message content because they must survive an
extension-host reload. Runtime directories are private to the user. Logs contain
metadata only and deliberately omit task bodies.

## Queue lifecycle

1. Inputs are read immediately and appended in deterministic FIFO order.
2. The worker waits while the exact workspace has a non-terminal Cline task.
3. One task or follow-up message is dispatched through Cline's public API.
4. The worker matches the exact workspace and prompt/session in Cline history.
5. Only the exact task's Cline UI history can authorize queue advancement;
   auxiliary session metadata is never accepted as terminal while that history
   is available. A `resume_task` marker remains incomplete. `completion_result`
   starts a 30-second advancement window (15 seconds of terminal stability plus
   a separate 15-second cooldown) and marks completion only if the task
   remains terminal throughout that window; resumed execution resets the timer.
   Historical recovery items carry their original Cline session ID and dispatch
   only through native history activation; they never fall back to
   `startNewTask`. The latest Cline task-progress checklist and every readable completion body
   pass through a mandatory audit. An incomplete progress count such as `4/13`, or structured
   remaining, outstanding, pending, future, deferred, open, incomplete, or
   partial-work declarations cause a continuation instruction to the same task.
   Audit-like tasks with concrete recommendation sections are likewise retained:
   recommendations not previously handled by that queue item are sent to the
   same task for implementation and, by default, a durable post-remediation
   report. Normalized recommendation keys prevent identical lists from causing
   an endless completion loop.
   Missing or truncated bodies are ambiguous and do not independently classify
   a task as incomplete. The queue item remains active until a later completion
   report contains no explicit unfinished-work declaration.
   An explicit provider context-window overflow error triggers `/compact` on
   that same task. After compaction finishes, the worker requests continuation
   and retains the queue item until normal completion. Each persisted error
   record is handled at most once; ordinary context-usage telemetry is ignored.
   A workspace-wide policy watcher selects the exact requesting session and
   rejects every persisted `new_task` handoff, including for directly started
   tasks, with a same-thread completion instruction that preserves the proposed
   handoff context as remaining work. Recent exact-workspace predecessor tasks
   are scanned to survive Cline's successor-selection race, while stale
   predecessor requests are excluded. It applies bounded timeouts and verifies
   that the instruction appears in the requesting task's persisted UI history
   before saving its handled marker. Failed or misdirected delivery is retried;
   verified prompt markers persist across extension restarts so the response is
   not duplicated. Compaction is reserved for actual context-window overflow.
   If an observed queued task disappears
   from Cline's exact-workspace history, it is marked skipped and the next item
   is dispatched without the normal task-to-task cooldown.
6. Queue state is persisted after every transition.

## Durable history

Each workspace companion dual-writes queue transitions into a shared private
SQLite WAL database. The schema separates immutable logical tasks, prompt
snapshots, queue projections, execution attempts, Cline session identifiers,
and append-only events. Event provenance distinguishes Cline observations from
cline-console derivations and user/CLI actions. Cline remains authoritative for
live execution; the database owns only cline-console identity, recovery, queue,
and audit history. Existing JSON queues remain the compatibility execution
source until a separately validated migration retires them.

## Trust boundaries

The IPC boundary is local-user-only, enforced with Unix socket and directory
permissions. Cline owns model credentials, approvals, tool permissions,
terminal execution, browser behavior, checkpoints, and provider configuration.
See [SECURITY.md](../SECURITY.md) for the explicit threat model.
