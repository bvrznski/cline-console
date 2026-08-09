# CLI reference

## Syntax

```text
cline-console [--workspace PATH] COMMAND [OPTIONS]
```

`--workspace` accepts an exact workspace or a path inside one. Without it, one
registered window is selected automatically. Multiple windows produce an
interactive selector; non-interactive use must specify a workspace.

## Commands

### `new`

```bash
cline-console --workspace /repo new -f task.md
cline-console --workspace /repo new "Prompt text"
cat task.md | cline-console --workspace /repo new -
```

Starts a task when the workspace is idle. If a task is running, an interactive
terminal offers queue, interrupt-and-replace, or abort and waits 30 seconds.
Timeout, EOF, and non-interactive collision handling abort safely.

### `send`

```bash
cline-console --workspace /repo send -f follow-up.md
cline-console --workspace /repo send "Continue with the tests"
```

Sends immediately to a completed task. If that task is running, the message is
persisted in the workspace FIFO and delivered after the current run completes.

### `add`

```bash
cline-console --workspace /repo add -f one.md two.md
cline-console --workspace /repo add -d task-directory
```

Queues files in argument order. Directory traversal is recursive and sorted by
relative path. Only regular files are accepted; symbolic links are ignored.

### `tasks`

```bash
cline-console --workspace /repo tasks
cline-console tasks
cline-console tasks --json
```

Displays workspace, normalized task state, underlying state, Cline version, and
the first prompt line as the title. Without `--workspace`, all registrations are
queried.

### `queue`

```bash
cline-console queue
cline-console queue --json
cline-console --workspace /repo queue
cline-console --workspace /repo queue --json
```

Without `--workspace`, displays currently running and waiting FIFO entries for
every registered workspace. Add `--workspace` to scope the result. Global JSON
output is an array; scoped JSON output is one object. Entries include position,
task/message type, state, first-line title, and source path without exposing
complete prompt bodies. Each workspace also summarizes retained completed and
failed history counts.

### Other commands

```bash
cline-console status [--json]
cline-console cancel
cline-console capabilities
cline-console workspaces
cline-console service install|start|stop|restart|status
```

`status` reports one selected workspace. `cancel` uses Cline's normal clear-task
command. `capabilities` reports adapter support. `workspaces` lists current
registrations. `service` manages the systemd user service.

## Exit behavior

- `0`: command completed, including a user-selected or timeout abort that made
  no changes.
- `1`: validation, routing, compatibility, service, or workspace error.

Errors are written to stderr. Human output goes to stdout. `--json` is supported
by status/task queries intended for automation.
