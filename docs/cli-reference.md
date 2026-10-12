# CLI reference

## Syntax

```text
cline-console [GLOBAL_OPTIONS] RESOURCE ACTION [ACTION_OPTIONS]
```

Resources are `task`, `queue`, `workspace`, and `service`. Global options may
appear before or after the resource:

```text
-w, --workspace PATH
--json
--no-color
--timeout SECONDS
-V, --version
-h, --help
```

The same reference is installed as a section-1 manual page:

```bash
man cline-console
```

`--workspace` accepts an exact workspace or a path inside one. Read-only list
actions may aggregate all registrations. Mutating queue actions require an
explicit workspace.

## Task commands

```bash
cline-console -w /repo task start --file task.md
cline-console -w /repo task start --text "Prompt text"
cat task.md | cline-console -w /repo task start --stdin
cline-console -w /repo task send --file follow-up.md
cline-console -w /repo task send --text "Continue with the tests"
cline-console -w /repo task status
cline-console tasks --json
cline-console -w /repo task stop
cline-console -w /repo task restart
cline-console -w /repo tasks finish
cline-console -w /repo task capabilities
```

`task start` accepts exactly one input source: `--file`, `--text`, or `--stdin`.
Batches belong to `queue add` or `queue replace`. An active-task collision opens
the bounded queue/replace/abort prompt. `task send` sends immediately to a
completed task or queues a follow-up for a running one.

`task status` reports one selected workspace. `tasks` reports all registered
workspaces unless scoped. `task stop` uses Cline's normal cancellation path.
`task restart` restarts the latest exact-workspace history item from its original
full prompt.

`tasks finish` discovers exact-workspace history entries whose latest readable
completion explicitly declares remaining work or whose latest Cline task
progress is incomplete, appends their original prompts
to the queue oldest-first, and
deduplicates entries already retained by that queue. Historical entries retain
their Cline session IDs and require native `showTaskWithId` support. If it is
unavailable, dispatch fails safely instead of starting a replacement task.

## Queue commands

```bash
cline-console /repo queue list
cline-console -w /repo queue add --file one.md two.md
cline-console -w /repo queue add -f replacement.md
cline-console -w ~/Gordon queue add /path/to/phases/10.14 - 30
cline-console -w ~/Gordon queue add /path/to/phases/0.12.md - 0.20
cline-console -w /repo queue replace /path/to/phases/0.12 - 0.20
cline-console -w /repo queue add --dir task-directory
cline-console -w /repo queue add --from task-directory/TASKS.txt
cline-console -w /repo queue add --dir task-directory --newer-than checkpoint.file
cline-console -w /repo queue add --file one.md --resume
cline-console -w /repo queue replace --file one.md two.md
cline-console -w /repo queue replace --dir replacement-directory
cline-console queue list
cline-console -w /repo queue list --json
cline-console -w /repo queue pause
cline-console -w /repo queue resume
cline-console -w /repo queue trim 2
cline-console -w /repo --continue
cline-console -w /repo --relaunch
cline-console -w /repo queue clear
cline-console -w /repo queue clear --force
cline-console -w /repo DONE
cline-console -w /repo queue remove --file /tasks/one.md
cline-console -w /repo queue remove --title "Displayed title"
cline-console -w /repo queue remove --id UUID
```

`queue add` appends batches in supplied order. The positional form
`START_FILE - END` expands matching regular sibling files inclusively in numeric
order (for example, `10.14 - 30` or `0.12.md - 0.20`); missing numbers are
skipped. The end may be an integer or a prefixed name. For `major.minor`
ranges, extensions are optional and the version may be a bounded token inside a
descriptive filename; for example, `24.0 - 24.21` matches sibling files such as
`24.0_foundation.md` and `phase_24.21_closure.txt`. Cross-major ranges such as
`0.13 - 2.15` compare `major.minor` version tuples. The CLI prints the expanded
list before queuing. `queue replace` accepts the same range form.
`--dir` traversal is recursive
and sorted by relative path; symbolic links are ignored. `--resume` clears a
persisted queue pause after appending. `queue replace` replaces waiting items
but preserves an active running item.

`queue add --from MANIFEST` accepts an ordered, newline-delimited list of task
file paths. Blank lines and lines beginning with `#` are ignored; relative paths
are resolved from the manifest directory.

`queue trim N` keeps the first `N` active queue positions and removes every
waiting item after that prefix in one operation. A running head counts as
position 1. `N` must be positive, so trim never removes a live head.

`queue resume` explicitly selects that workspace for execution. For workspaces
sharing one LM Studio model, it preempts the competing queue and transfers the
lease after the configured 15-second handoff delay.

`--continue` gently asks the current owned task thread to continue.
`--relaunch` force-starts the current queue item from its original prompt in a
fresh owned Cline session and resets its per-run completion state. If the exact
workspace companion is absent, the daemon first reopens that workspace.

The short `-f` input form also requests an interrupted-task override. When the
queue has a persisted running head but Cline is not actually executing, that
head is recorded as `skipped` and the supplied task is dispatched from its
original prompt with no resume session. Existing waiting items remain queued
after the replacement. If Cline is genuinely running, `-f` only appends and
does not interrupt it. Use `--file` or positional files for append-only behavior.

A leading workspace path is accepted as shorthand for `-w PATH` when followed
by a top-level command, so `cline-console ~/Gordon queue list` and
`cline-console -w ~/Gordon queue list` are equivalent.

All task-affecting behavior is limited to durably recorded cline-console-owned
Cline sessions. Manually started Cline UI tasks are ignored by scanning, status,
handoff correction, recovery, follow-up, cancellation, reload, and unfinished-
task discovery. They still block queue dispatch until Cline becomes idle.
With directory mode, `--newer-than REFERENCE_FILE` keeps only files whose
modification time is strictly greater than the reference file's modification
time. It is supported by both `queue add` and `queue replace`.

`--scope PATH` is supported by `queue add` and `queue replace`. The path must
resolve to an existing file or directory inside the selected workspace. It is
persisted per task, and Cline-authored edits outside it trigger a same-thread
correction plus a `task_scope_violation` SQLite event. Reads, user edits, and
text that merely mentions a path do not trigger the guard.

If the selected workspace has an incomplete task in `waiting` state, `queue add`
prompts to resume it from its original prompt, skip that exact task for the next
queue dispatch, or abort. The choice times out after 30 seconds. Timeout, EOF,
and non-interactive execution abort before files are read or queued.

`queue list` displays active FIFO entries from persisted queues, including
workspaces whose VS Code companion is temporarily offline. A persisted running
entry is displayed as magenta `interrupted` whenever VS Code is offline or Cline
is waiting or unavailable; observed terminal states are displayed as `completed`
or `failed`. It returns to `running` only while Cline reports live execution. A
task closed explicitly with `DONE` remains visible as `closed`. These display-only
states preserve the internal records needed for recovery and history.
Add `--workspace` to scope the result. Global JSON
output is an array; scoped JSON output is one object. Entries include position,
task/message type, state, first-line title, and source path without exposing
complete prompt bodies. Output reports whether the workspace companion is
connected. Each workspace also summarizes retained completed and
failed history counts. Human-readable output aligns columns to their widest
visible values and separates headers from entries with a horizontal rule.

Queued tasks require a terminal status to remain stable for at least 15 seconds
before completion is recorded. Resumed activity resets that timer. They then
have a 15-second dispatch cooldown after the preceding queued task completes or
fails. The persisted cooldown survives extension reloads. Messages
are delivered without this task-to-task delay. Workspace activity is rechecked
after an idle stabilization interval and after cooldown before dispatch.

The task scanner is configured globally through VS Code User Settings under
`cline-console.taskScanner.*`. Its default policies detect incomplete completion
reports and unresolved test timeouts, implement concrete audit recommendations
in the same task, and require a post-remediation report. See the README settings
table for every key and default.
An exact Cline YOLO-mode stop after three consecutive mistakes can additionally
request guarded daemon recovery. The daemon terminates only the registered,
`/proc`-validated extension-host PID, asks VS Code to reopen the same workspace,
and records the outcome in SQLite; it does not broadly terminate VS Code.
The repeated incomplete-completion correction is capped at five consecutive
`STOP:` responses without detected implementation activity. Any implementation
activity resets that streak; reaching the cap fails the queue item rather than
silently accepting an incomplete result or issuing an unbounded sixth request.
If a running queue item disappears from Cline's history and its own transcript
is also absent, it remains the current interrupted item and the queue pauses.
It is never converted to skipped work and no later FIFO item advances. A
surviving exact-prompt transcript remains authoritative while another VS Code
workspace transiently rewrites Cline's shared history index.

`pause` persists a stop-after-current-item boundary: the running item is
preserved, but no waiting item dispatches afterward. `resume` clears that pause
and kicks queue processing when persisted items remain. `clear` enforces removal
of all running and waiting queue entries without modifying Cline history. Only
`clear --force` also cancels an exact active queue match and deletes exact
workspace/full-prompt or recorded-ID matches from Cline history. `queue remove` removes exactly one waiting
entry with an explicit file, title, or ID selector. Ambiguous titles are
rejected.

`DONE` (or `task done`) is a manual, CLI-originated completion confirmation for
the current running queue task. It bypasses further scanner correction rounds,
records the owner decision in history, and leaves normal idle/cooldown dispatch
safeguards active. Text emitted by the agent does not activate this override.

## Workspace and service commands

`workspace list` displays registered VS Code workspaces. `workspace clear`
requires `--workspace` and removes the selected workspace's cline-console queue
state without altering Cline history.

```bash
cline-console workspace list
cline-console service install|start|stop|restart|status
```

## History commands

```bash
cline-console history path
cline-console history list [--limit NUMBER]
cline-console -w /repo history list [--limit NUMBER]
cline-console history show TASK_ID
```

`history list` displays durable task identities without full prompt bodies.
`history show` returns the complete stored record, including its immutable
initial prompt, runs, and events. The SQLite database is separate from Cline's
history and is not erased by queue clearance. It uses the supported
`better-sqlite3` backend with WAL, full synchronous commits, a busy timeout,
schema migration, and an open-time consistency check.

## Compatibility aliases

Pre-0.12 commands remain operational and print a deprecation warning. Examples
include `new`, `send`, `add`, `resume`, `cancel`, `status`, `task list`, `workspaces`,
bare `queue`, and `queue pop`. They map to the canonical resource/action grammar
without changing task or queue behavior.

## Exit behavior

- `0`: command completed, including a user-selected or timeout abort that made
  no changes.
- `1`: validation, routing, compatibility, service, or workspace error.

Errors are written to stderr. Human output goes to stdout. `--json` is supported
by status/task queries intended for automation.
