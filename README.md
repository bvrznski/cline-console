# cline-console

`cline-console` is a local control plane for the Cline extension already running in VS Code. It submits tasks and follow-up messages to Cline's extension API, so Cline remains responsible for providers, LM Studio configuration, history, checkpoints, approvals, terminals, tools, and its visible UI.

> `cline-console` does not run the standalone Cline CLI. It controls the Cline extension running inside VS Code.

The project is pre-1.0 and currently verified on Linux with VS Code, systemd user
services, Node.js 18+, and Cline Legacy 4.1.7. It is an independent project and
is not affiliated with or endorsed by Cline or its maintainers.

## Documentation

- [CLI reference](docs/cli-reference.md)
- [Architecture](docs/architecture.md)
- [Operations and troubleshooting](docs/operations.md)
- [Publishing checklist](docs/publishing.md)
- [Cline compatibility evidence](docs/cline-legacy-4.1.6-integration.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Architecture

```text
terminal CLI -> singleton cline-console user service
             -> selected per-workspace Unix socket -> companion VS Code extension
             -> Cline public extension API -> Cline controller/task/UI
```

Each VS Code workspace registers a private Unix socket below `$XDG_RUNTIME_DIR/cline-console` (falling back to `~/.cache/cline-console`). Requests use a versioned newline-delimited JSON protocol. The directory is mode `0700`; registrations and sockets are mode `0600`. No TCP listener is created. Starting a task reveals and focuses Cline's normal sidebar before submission.

## Install from source

Requirements: Linux, Node.js 18+, VS Code, and a compatible Cline Legacy extension.

```bash
npm install
npm run build
npm run package
code --install-extension cline-console-0.4.1.vsix
npm link
cline-console service install
```

Reload VS Code after installing. The companion starts automatically for filesystem workspaces.

For a future published release, install the CLI from npm and the companion from
the VS Code Marketplace, then install the user service:

```bash
npm install --global cline-console
cline-console service install
```

## Usage

```bash
cline-console new -f task.md
cline-console new "Implement the task described here"
cat task.md | cline-console new -
cline-console --workspace /path/to/repo add -f task_1.md task_2.md
cline-console --workspace /path/to/repo add -d tasks/
cline-console send -f continuation.md
cline-console send "Continue and fix the remaining tests."
cline-console cancel
cline-console status
cline-console status --json
cline-console --workspace /path/to/repo tasks
cline-console tasks
cline-console tasks --json
cline-console queue
cline-console --workspace /path/to/repo queue
cline-console --workspace /path/to/repo queue --json
cline-console capabilities
cline-console workspaces
cline-console service status
```

`tasks` with `--workspace` checks one VS Code workspace; without it, it lists every registered workspace. Example:

```text
Workspace              Task       State      Cline  Title
/path/to/repository    completed  completed  4.1.7  # Build feature
```

The `Task` column is the normalized result. `State` retains Cline's underlying task value, and `Title` is the first line of the original task prompt. A completed task remains open for follow-up messages.

`queue` displays running and waiting task/message entries across every registered
workspace. Add `--workspace PATH` to scope the view to one workspace. It includes
first-line titles and source paths but never prints full prompt bodies. Summary
counts show retained completed/failed history.

With multiple windows, select explicitly:

```bash
cline-console --workspace /absolute/path/to/repository new -f task.md
```

Without `--workspace`, one registered VS Code window is selected automatically. When multiple windows are registered, an interactive terminal displays a numbered selection prompt. Empty or invalid selection cancels before files are read or tasks are added. Non-interactive commands fail safely and require an explicit `--workspace`; a workspace is never chosen arbitrarily.

When `new` targets a workspace with a live Cline task, it waits up to 30 seconds for an interactive choice:

```text
1) Add the new task to the queue
2) Interrupt the current task and replace it
3) Abort
```

Choice 1 preserves the current task and queues the new file. Choice 2 uses Cline's normal clear/start transition. Choice 3, timeout, EOF, or non-interactive execution aborts before reading, queuing, or submitting the new task. Invalid answers may be corrected within the original 30-second deadline.

`send` follows up on the current task. If that task is idle/completed, the message is delivered immediately. If it is still running, the message is appended to the same persistent FIFO queue and delivered to that task after its current run completes:

```bash
cline-console --workspace /path/to/workspace send -f message.md
cline-console --workspace /path/to/workspace send "Please also update the tests"
```

The command reports either `Message sent to completed Cline task.` or `Message queued for the active task.` No prompt is required for this decision.

## Supported Cline versions

The compatibility adapter targets the public Legacy API found in locally installed Cline 4.1.7 and expected in the 4.1.6 family: `startNewTask` and `sendMessage`. Only 4.1.7 was present for source inspection on this machine; 4.1.6 must be verified by the manual checklist in `docs/cline-legacy-4.1.6-integration.md`.

The existing provider remains authoritative, including a local LM Studio backend. `cline-console` never reads or changes provider credentials.

## Status and cancellation limitations

Cline Legacy's exported API does not expose authoritative task status or cancellation. `cline-console` therefore reads Cline's own task history, matches `cwdOnTaskInitialization` to the exact workspace, and inspects the task's latest UI message. A terminal `completion_result` is completed; an unfinished API/tool/result stream is running. Timestamped session metadata remains a fallback. Cancellation invokes Cline's registered `cline.plusButtonClicked` command, whose Legacy implementation calls `controller.clearTask()` and opens the normal new-task UI. It never kills VS Code or LM Studio.

`tasks` queries one workspace when `--workspace PATH` is supplied, or every registered VS Code workspace when it is omitted. It reports the latest reconciled session state for each workspace.

## Queued task files

`add` reads every file immediately, preserves its exact UTF-8 content, and appends the prompts to that workspace's persistent FIFO queue. Follow-up messages queued by `send` use this same queue, preserving task/message ordering:

```bash
cline-console --workspace /path/from/cline-console-workspaces add -f task_1.md task_2.md
cline-console --workspace /path/from/cline-console-workspaces add -d task-directory
cline-console --workspace /path/from/cline-console-workspaces queue
```

Directory mode recursively queues all regular files in deterministic relative-path order. Symbolic links are ignored so discovery cannot escape or duplicate the selected tree. An empty directory, empty task file, or mixed `-f`/`-d` invocation is rejected explicitly.

The companion waits for the workspace's current Cline task to finish, dispatches one queued prompt through Cline's public extension API, watches the matching workspace and full prompt in Cline's task history for a terminal `completion_result`, and then dispatches the next item. Legacy session metadata remains a fallback. Queue state is stored privately beside the workspace socket and survives extension-host reloads. A task waiting for user approval has no `completion_result`, so the next task is not dispatched prematurely.

## Logs

CLI, IPC, adapter, and queue events are written without prompt bodies to:

```text
$XDG_STATE_HOME/cline-console/cline-console.log
```

The fallback is `~/.local/state/cline-console/cline-console.log`. The directory is mode `0700`, the log is mode `0600`, and the previous log is retained as `.1` after the active file exceeds 5 MiB.

## Singleton service

Operational CLI requests pass through one local user service at `$XDG_RUNTIME_DIR/cline-console/service.sock`. Install and start it once with:

```bash
cline-console service install
```

This creates and enables `~/.config/systemd/user/cline-console.service`. The Unix socket enforces the singleton atomically: a second `cline-console service run` fails while the first is live. Stale sockets are removed safely, but non-socket paths are never replaced.

```bash
cline-console service status
cline-console service start
cline-console service stop
cline-console service restart
```

The service is only a local router and queue control plane. Cline inside VS Code remains the execution engine.

## Troubleshooting

- “No running VS Code workspaces”: install/enable the companion, reload the target window, and open a folder workspace.
- “Multiple VS Code workspaces”: pass `--workspace`.
- “does not expose startNewTask/sendMessage”: the installed Cline build is incompatible; inspect `Cline Console` in VS Code's Output panel.
- Socket problems: run “Cline Console: Stop Server”, then “Start Server” from the command palette. A server only removes a pre-existing path if it is a Unix socket.

Prompts are not logged. Set `cline-console.logLevel` to `debug` for connection diagnostics.
