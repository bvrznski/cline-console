# Operations and troubleshooting

## Installation

```bash
npm install -g cline-console
code --install-extension cline-console-<version>.vsix
cline-console service install
```

Reload every open VS Code window after installing or upgrading the companion.
The extension host keeps the previous code until the window reloads.
The npm package installs `cline-console(1)`; open it with `man cline-console`.

## Health checks

```bash
cline-console service status
cline-console workspace list
cline-console tasks
cline-console --workspace /repo task stop
cline-console --workspace /repo task restart
cline-console --workspace /repo queue pause
cline-console --workspace /repo queue resume
cline-console --workspace /repo queue add --file task.md --resume
cline-console --workspace /repo queue add --dir tasks --newer-than checkpoint.file
cline-console --workspace /repo queue remove --file /path/to/task.md
cline-console queue list
cline-console task capabilities
```

Interactive `queue add` requests detect incomplete waiting tasks and offer resume,
skip, or abort. Resume restarts the original prompt because Cline Legacy does
not export a direct resume API. Skip is scoped to the exact waiting task ID.

## Logs

The default log is:

```text
~/.local/state/cline-console/cline-console.log
```

Set `cline-console.logLevel` to `debug` in VS Code settings for additional
transport diagnostics. Prompt and message bodies are never written to the log.

## Common failures

### Workspace is missing

Open a filesystem folder in VS Code, install/enable the companion, and reload
the window. Run `cline-console workspace list` again.

### Multiple workspaces

Use `--workspace /absolute/path`. Scripts and redirected input cannot use the
interactive selector.

### Queue does not advance

Check `cline-console tasks`. A running task or approval request intentionally
blocks the FIFO. If Cline reports completion but the queue remains unchanged,
confirm the target window loaded the latest extension with **Developer: Reload
Window**, then inspect the queue logs.

Resume processing explicitly with:

```bash
cline-console --workspace /repo queue resume
```

Normal task-to-task queue advancement first confirms terminal state for at
least 60 seconds, then includes a 30-second cooldown. During
that interval, `queue pause`, `queue clear`, and queue replacement remain
effective before the next dispatch.

Remove all waiting items without cancelling the running task with:

```bash
cline-console --workspace /repo queue clear
```

The command also removes a stale queue entry marked `running` when the same
workspace is not active in `cline-console --workspace /repo task status`. Active or
unavailable status is preserved conservatively.

### Service socket is absent

```bash
cline-console service restart
systemctl --user status cline-console.service
```

The service may take a brief moment to recreate its socket after a restart.

### Cline API is unsupported

The verified adapter targets Cline Legacy 4.1.7 and the expected 4.1.6 API
family. A different Cline release may require a new compatibility adapter.
