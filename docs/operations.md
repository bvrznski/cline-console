# Operations and troubleshooting

## Installation

```bash
npm install -g cline-console
code --install-extension cline-console-<version>.vsix
cline-console service install
```

Reload every open VS Code window after installing or upgrading the companion.
The extension host keeps the previous code until the window reloads.

## Health checks

```bash
cline-console service status
cline-console workspaces
cline-console tasks
cline-console capabilities
```

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
the window. Run `cline-console workspaces` again.

### Multiple workspaces

Use `--workspace /absolute/path`. Scripts and redirected input cannot use the
interactive selector.

### Queue does not advance

Check `cline-console tasks`. A running task or approval request intentionally
blocks the FIFO. If Cline reports completion but the queue remains unchanged,
confirm the target window loaded the latest extension with **Developer: Reload
Window**, then inspect the queue logs.

### Service socket is absent

```bash
cline-console service restart
systemctl --user status cline-console.service
```

The service may take a brief moment to recreate its socket after a restart.

### Cline API is unsupported

The verified adapter targets Cline Legacy 4.1.7 and the expected 4.1.6 API
family. A different Cline release may require a new compatibility adapter.
