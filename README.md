# cline-console

`cline-console` controls the Cline extension running inside VS Code from a
terminal. It can start tasks, send follow-up messages, inspect task state, and
run persistent per-workspace FIFO queues.

```text
terminal CLI
    -> singleton user service
        -> selected VS Code workspace companion
            -> Cline extension API
                -> Cline task, provider, approvals, tools, and UI
```

`cline-console` is a control plane, not an alternative agent runtime. It does
not call model providers directly, duplicate Cline's task loop, or use the
standalone Cline CLI. Cline remains responsible for credentials, models,
checkpoints, approvals, terminals, browser tools, and visible task execution.

The project is pre-1.0, Linux-oriented, and currently verified with Node.js
18+, VS Code, systemd user services, and Cline Legacy 4.1.7. It is independent
and is not affiliated with or endorsed by Cline or its maintainers.

## Features

- Route commands to an exact VS Code filesystem workspace.
- Start tasks from a file, inline text, or standard input.
- Send messages immediately or queue them behind an active task.
- Maintain persistent, ordered task queues independently for each workspace.
- Add batches from explicit files or recursively from a directory.
- Filter directory batches using a `--newer-than` reference file.
- Pause, resume, replace, inspect, remove, and clear queued work.
- Reconcile task state against Cline's exact-workspace history.
- Keep queues visible while a VS Code companion is temporarily offline.
- Run through one private, singleton systemd user service.
- Produce aligned colored terminal output and JSON for automation.
- Log operational metadata without logging prompt or message bodies.

## Requirements

- Linux with systemd user services
- Node.js 18 or newer
- VS Code 1.85 or newer
- A compatible Cline extension; Cline Legacy 4.1.7 is the verified target

## Install from source

```bash
git clone https://github.com/bvrznski/cline-console.git
cd cline-console
npm install
npm run build
npm run package
code --install-extension cline-console-0.13.0.vsix
npm link
cline-console service install
```

Reload each target VS Code window after installing the VSIX. The companion
activates automatically when a filesystem workspace is open.

Verify the installation:

```bash
cline-console --version
cline-console service status
cline-console workspace list
```

`npm link` or a global npm installation also installs the section-1 manual:

```bash
man cline-console
```

## Quick start

Open the target repository in VS Code, then start a task:

```bash
cline-console -w /path/to/repository task start --file task.md
```

Append a batch and inspect it:

```bash
cline-console -w /path/to/repository queue add --file task-1.md task-2.md
cline-console -w /path/to/repository queue list
```

List current task state:

```bash
cline-console tasks
cline-console -w /path/to/repository tasks
```

## Command reference

The canonical syntax is:

```text
cline-console [GLOBAL_OPTIONS] RESOURCE ACTION [ACTION_OPTIONS]
```

Global options may appear before or after the resource:

| Option | Meaning |
| --- | --- |
| `-w, --workspace PATH` | Select an exact workspace or a path inside it |
| `--json` | Emit machine-readable output where supported |
| `--no-color` | Disable ANSI colors |
| `--timeout SECONDS` | Set interactive prompt timeout; default: 30 seconds |
| `-V, --version` | Print the version |
| `-h, --help` | Print command help |

### Tasks

```bash
cline-console -w /repo task start --file task.md
cline-console -w /repo task start --text "Implement the requested change"
cat task.md | cline-console -w /repo task start --stdin

cline-console -w /repo task send --file follow-up.md
cline-console -w /repo task send --text "Also update the tests"
cline-console -w /repo task send --stdin

cline-console -w /repo task status
cline-console -w /repo task capabilities
cline-console -w /repo task stop
cline-console -w /repo task restart
cline-console tasks
cline-console -w /repo tasks
cline-console -w /repo tasks finish
```

`task start` accepts one input source. Use `queue add` for batches. If a task is
already active, an interactive terminal offers three choices for up to 30
seconds: queue the new task, interrupt and replace the current task, or abort.
Timeout, EOF, and non-interactive ambiguity abort before the input is submitted.

`task send` sends directly to an idle/completed task. When the task is still
running, the message joins that workspace's FIFO and is delivered to the same
task after its current run ends.

`task restart` retrieves the latest exact-workspace task from Cline history and
uses its original full prompt. It never reconstructs a prompt from the console
title.

`tasks finish` finds exact-workspace history items whose latest readable
completion explicitly declares remaining work or whose latest Cline task
progress remains below its total (for example, `4/13`), queues their original full
prompts oldest-first, and
deduplicates items already retained in queue history. Historical recovery
requires a compatible native `showTaskWithId` API and fails safely when it is
absent; it never falls back to starting a replacement task.

### Queues

```bash
# Append
cline-console -w /repo queue add --file one.md two.md
cline-console -w /repo queue add --dir tasks/
cline-console -w /repo queue add --dir tasks/ --newer-than checkpoint.file
cline-console -w /repo queue add --file next.md --resume

# Replace waiting entries; preserve a genuinely running entry
cline-console -w /repo queue replace --file one.md two.md
cline-console -w /repo queue replace --dir replacement/
cline-console -w /repo queue replace --dir replacement/ --newer-than checkpoint.file

# Inspect and control
cline-console queue list
cline-console -w /repo queue list --json
cline-console -w /repo queue pause
cline-console -w /repo queue resume
cline-console -w /repo queue clear
cline-console -w /repo queue clear --force

# Remove one waiting entry
cline-console -w /repo queue remove --file /absolute/path/to/task.md
cline-console -w /repo queue remove --title "Displayed title"
cline-console -w /repo queue remove --id UUID
```

`queue add` preserves supplied file order. Directory traversal is recursive and
sorted by relative path; symbolic links are ignored. `--newer-than FILE`
includes only regular files whose modification time is strictly newer than the
reference file. Files are read immediately and their exact UTF-8 contents are
persisted in the queue.

`queue pause` lets the current item finish and stops before the next dispatch.
`queue resume` clears that persisted boundary. `queue remove` affects one
waiting item and rejects ambiguous titles; it never removes a running item.

#### Completion safety

A queued task advances only after all of these conditions hold:

1. The exact task has been observed in Cline's workspace history. Auxiliary
   session metadata cannot independently authorize completion.
2. Cline records `completion_result`; `resume_task` remains incomplete and
   blocks the queue.
3. The result remains continuously terminal for at least 30 seconds. Any
   resumed activity resets that confirmation timer.
4. The mandatory completion audit finds no incomplete task-progress counter and no
   structured remaining, outstanding, pending, future, deferred, open,
   incomplete, or partial-work declaration. A missing or truncated body is not
   sufficient by itself to classify a task as incomplete.
5. After confirmation, a separate 30-second inter-task cooldown completes.
6. Workspace activity is checked again immediately before dispatch.

Consequently, at least 60 seconds normally pass between the first terminal
signal and the next task. Queued follow-up messages do not use the task-to-task
cooldown. If an observed running queue task is deleted from Cline history, it is
marked skipped and the next matching FIFO item may advance immediately.

If a completion result explicitly lists remaining work, the worker parses concrete
unchecked, numbered, bulleted, inline, and incomplete-counter steps and sends them in a
follow-up instructing that same task to finish and validate every remaining
item. It retains the running queue entry and waits for a later complete result
that no longer declares unfinished work. Empty declarations such as `None`,
`N/A`, and `all completed` do not trigger a follow-up.

If the task repeatedly claims completion while its task-progress report remains
incomplete, the scanner keeps the same task thread and escalates the follow-up.
It requires a stage-by-stage comparison with the complete original prompt,
accurate progress updates, and implementation and validation of every remaining
stage before another completion attempt. The escalation quotes the concrete
steps parsed from task progress and the completion report, and explicitly flags
incomplete entries that simultaneously claim `COMPLETED`, so the follow-up is
tied to observable task state instead of generic wording.

An unresolved Cline `Task failed:` error triggers `/compact` followed by
`continue` in the same task, even when Cline follows the error with a
`resume_task` prompt. The complete failure text and handled marker are retained
in queue state and SQLite history, preventing repeated recovery for one error;
a later real retry supersedes it.

An explicit timeout from a recognized test command (`pytest`, `unittest`, npm,
pnpm, Yarn, Cargo, Go, CTest, Maven, Gradle, RSpec, or `dotnet test`) also blocks
completion. The scanner quotes the timed-out command and requires diagnosis,
bounded timeout and cleanup behavior, regression coverage, and a successful
rerun of the same test scope. A passing narrower command does not clear the
original timeout, and a timeout is never treated as passing evidence.

If Cline records an explicit provider context-window overflow error, the worker
sends `/compact` to the same task, waits for compaction processing, and then
asks the task to continue from where it stopped. Each persisted overflow error
is handled once. Ordinary context-window usage telemetry does not trigger
automatic compaction.

The workspace policy watcher explicitly forbids Cline's `new_task` handoff for
all future tasks, including tasks started directly rather than through the
queue. It answers each persisted handoff once with `/compact` followed by
a direct same-thread completion instruction, and never dispatches the proposed
handoff as a new task. Compaction and completion are persisted as separate
recovery stages, so a temporarily blocked follow-up is retried without sending
`/compact` repeatedly. Each send is bounded by a timeout and handled markers
survive extension restarts.

#### Clearing queues and history

`queue clear` removes all waiting and running cline-console queue entries but
does not alter Cline history or cancel the displayed Cline task. Only
`queue clear --force` additionally cancels an exact queue match and deletes its
matching Cline history records and per-task storage. Unrelated manual tasks and
other workspaces are preserved.

### Workspaces

```bash
cline-console workspace list
cline-console -w /repo workspace clear
```

`workspace list` shows registered VS Code workspaces. Queue listing can also
discover persisted queues whose companions are temporarily offline.

`workspace clear` clears cline-console queue state for the selected workspace.
It does not alter Cline history; history deletion is reserved exclusively for
`queue clear --force`.

### Durable history database

cline-console maintains a private SQLite database independently of Cline's own
history:

```bash
cline-console history path
cline-console history list
cline-console -w /repo history list --limit 200
cline-console history show TASK_ID
```

The database defaults to
`~/.local/share/cline-console/history.sqlite3`, with a `0700` parent directory
and `0600` database. It uses foreign keys, WAL journaling, full synchronous
commits, schema migrations, immutable full initial prompts and hashes, prompt
snapshots, canonical workspaces, queue projections, task runs, Cline session
IDs, recovery markers, errors, and append-only structured events. Events label
their source and distinguish observations imported from Cline from state derived
by cline-console.

Cline remains authoritative for live UI/session state. SQLite is authoritative
for cline-console's durable audit trail and identity mapping. During the initial
migration, the existing JSON queue remains the live compatibility source and is
transactionally mirrored into SQLite. Clearing a queue marks its historical
projection `cleared`; it does not erase the audit record. `history show` is
intentionally explicit because it displays the full stored initial prompt.

### Service

```bash
cline-console service install
cline-console service start
cline-console service stop
cline-console service restart
cline-console service status
cline-console service run
```

`service install` creates and enables
`~/.config/systemd/user/cline-console.service`. Only one service may own the
local routing socket. `service run` is intended for foreground diagnostics.

## Workspace selection

Use `-w` or `--workspace` for deterministic automation:

```bash
cline-console -w /absolute/path/to/repository queue list
```

Without it:

- One registered VS Code workspace is selected automatically.
- Multiple registered workspaces trigger a numbered prompt in an interactive
  terminal.
- Non-interactive ambiguity fails safely.
- `queue list` aggregates persisted queues rather than prompting.

Explicit workspace lookup retries briefly during VS Code activation, avoiding
false “not registered” errors during normal startup.

## Task and queue output

`tasks` reports normalized task state, Cline's underlying state, Cline version,
a meaningful first-line title, and the queued source path when known:

```text
Workspace  Task    State    Cline  Title             Source
/repo      active  running  4.1.7  # Build feature   /tasks/build.md
```

`queue list` displays aligned position, type, state, title, and source columns.
It never prints complete prompt bodies. JSON output is available for scripting.
Colors are disabled automatically for redirected output, `TERM=dumb`, JSON,
`NO_COLOR`, or `--no-color`.

## Persistence and security

| Data | Default location |
| --- | --- |
| Service socket | `$XDG_RUNTIME_DIR/cline-console/service.sock` |
| Registrations and queues | `$XDG_RUNTIME_DIR/cline-console/` |
| Log | `$XDG_STATE_HOME/cline-console/cline-console.log` |
| User service | `~/.config/systemd/user/cline-console.service` |

Fallbacks are `~/.cache/cline-console` for runtime data and
`~/.local/state/cline-console` for logs. Runtime and log directories are mode
`0700`; files and sockets are mode `0600`. No TCP listener is created.

Queue files contain complete task/message content because that content must
survive extension-host reloads. Logs contain operational metadata only and omit
prompt bodies. The active log rotates at 5 MiB and retains one `.1` file.

## Compatibility

The adapter uses the `startNewTask` and `sendMessage` API verified in Cline
Legacy 4.1.7. Status and completion are reconciled from Cline's persisted
exact-workspace history because Legacy does not export authoritative lifecycle
state. See [the compatibility evidence](docs/cline-legacy-4.1.6-integration.md)
for implementation details and the 4.1.6 verification checklist.

Older commands remain available with migration warnings, including `new`,
`send`, `add`, `resume`, `cancel`, `status`, `task list`, `workspaces`, bare
`queue`, and `queue pop`.

## Troubleshooting

### Workspace is not registered

1. Confirm the folder is open as a filesystem workspace in VS Code.
2. Confirm the Cline Console companion is installed and enabled.
3. Reload that VS Code window.
4. Run `cline-console workspace list`.
5. Check the **Cline Console** channel in VS Code's Output panel.

### Service is unavailable

```bash
cline-console service status
cline-console service restart
systemctl --user status cline-console.service
```

### Queue appears offline

`queue list` can read persisted state without a live companion. Read-only output
will say `VS Code companion: offline`; mutations require the workspace companion
to reconnect.

### More diagnostics

Set `cline-console.logLevel` to `debug` in VS Code and inspect:

```text
~/.local/state/cline-console/cline-console.log
```

## Development

```bash
npm install
npm run build
npm test
npm run package
npm run verify:release
```

`npm test` builds TypeScript and runs the Node test suite. `verify:release` also
runs the dependency audit, npm package dry run, and VSIX content inspection.

## Documentation

- [CLI reference](docs/cli-reference.md)
- [Manual page](man/cline-console.1)
- [Architecture](docs/architecture.md)
- [Operations and troubleshooting](docs/operations.md)
- [Cline compatibility evidence](docs/cline-legacy-4.1.6-integration.md)
- [Publishing checklist](docs/publishing.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## License

See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).
