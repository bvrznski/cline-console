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

## Queue commands

```bash
cline-console -w /repo queue add --file one.md two.md
cline-console -w /repo queue add --dir task-directory
cline-console -w /repo queue add --dir task-directory --newer-than checkpoint.file
cline-console -w /repo queue add --file one.md --resume
cline-console -w /repo queue replace --file one.md two.md
cline-console -w /repo queue replace --dir replacement-directory
cline-console queue list
cline-console -w /repo queue list --json
cline-console -w /repo queue pause
cline-console -w /repo queue resume
cline-console -w /repo queue clear
cline-console -w /repo queue remove --file /tasks/one.md
cline-console -w /repo queue remove --title "Displayed title"
cline-console -w /repo queue remove --id UUID
```

`queue add` appends batches in supplied order. `--dir` traversal is recursive
and sorted by relative path; symbolic links are ignored. `--resume` clears a
persisted queue pause after appending. `queue replace` replaces waiting items
but preserves an active running item.
With directory mode, `--newer-than REFERENCE_FILE` keeps only files whose
modification time is strictly greater than the reference file's modification
time. It is supported by both `queue add` and `queue replace`.

If the selected workspace has an incomplete task in `waiting` state, `queue add`
prompts to resume it from its original prompt, skip that exact task for the next
queue dispatch, or abort. The choice times out after 30 seconds. Timeout, EOF,
and non-interactive execution abort before files are read or queued.

`queue list` displays currently running and waiting FIFO entries from persisted
queues, including workspaces whose VS Code companion is temporarily offline.
Add `--workspace` to scope the result. Global JSON
output is an array; scoped JSON output is one object. Entries include position,
task/message type, state, first-line title, and source path without exposing
complete prompt bodies. Output reports whether the workspace companion is
connected. Each workspace also summarizes retained completed and
failed history counts. Human-readable output aligns columns to their widest
visible values and separates headers from entries with a horizontal rule.

Queued tasks require a terminal status to remain stable for at least 60 seconds
before completion is recorded. Resumed activity resets that timer. They then
have a 30-second dispatch cooldown after the preceding queued task completes or
fails. The persisted cooldown survives extension reloads. Messages
are delivered without this task-to-task delay. Workspace activity is rechecked
after an idle stabilization interval and after cooldown before dispatch.
If the running queue item disappears from Cline's exact-workspace task history,
the item is retained as skipped and the next matching FIFO item advances
immediately.

`pause` persists a stop-after-current-item boundary: the running item is
preserved, but no waiting item dispatches afterward. `resume` clears that pause
and kicks queue processing when persisted items remain. `clear` enforces removal
of all running and waiting entries; exact workspace/full-prompt or recorded-ID matches are also
deleted from Cline history, while unrelated tasks remain. `queue remove` removes exactly one waiting
entry with an explicit file, title, or ID selector. Ambiguous titles are
rejected.

## Workspace and service commands

`workspace list` displays registered VS Code workspaces. `workspace clear`
requires `--workspace` and removes the selected workspace's entire queue plus
all exact-workspace Cline history and per-task storage. Other workspaces are
preserved.

```bash
cline-console workspace list
cline-console service install|start|stop|restart|status
```

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
