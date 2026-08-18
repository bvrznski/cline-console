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
5. `completion_result` starts a 60-second confirmation window. It marks
   completion only if the task remains terminal throughout that window; resumed
   execution resets the timer. If an observed queued task disappears
   from Cline's exact-workspace history, it is marked skipped and the next item
   is dispatched without the normal task-to-task cooldown.
6. Queue state is persisted after every transition.

## Trust boundaries

The IPC boundary is local-user-only, enforced with Unix socket and directory
permissions. Cline owns model credentials, approvals, tool permissions,
terminal execution, browser behavior, checkpoints, and provider configuration.
See [SECURITY.md](../SECURITY.md) for the explicit threat model.
