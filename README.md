# cline-console

### Live terminal dashboard

Use `cline-console -w ~/rebuntu --watch` for one workspace, or
`cline-console --watch` for all registered workspaces separated by
lines. Both views list only workspaces with active queue work (`running`,
`waiting`, `interrupted`, or `queued`); completed and empty queues disappear.
An offline workspace remains visible only while its durable queue still contains
active work.
Each section shows the current console queue task above its queue,
with a timestamped dashboard header, per-state counters, task source/scope,
active execution time, separate wall time since dispatch, and an aligned queue table
whose `AHEAD` column shows how many active queue items precede each waiting task.
The top of every workspace section includes a live `QUEUE LEFT` counter with the
number of unfinished items, scale-aware `QUEUE ETA`, predicted local `END` date
and time, and model confidence. Multi-day ETAs use `2d 03h 04m` rather than an
unbounded hour count. If the current task exceeds P90, the dashboard retains an
explicitly approximate (`~`) active-work ETA instead of discarding the estimate
for the whole queue. Paused, interrupted, or offline queues show the calendar
date as `END blocked (<reason>)`, because wall-clock completion is not advancing.
Once the workspace has completed-task duration samples, the dashboard also shows
robust P50/P75/P90 percentiles, a trimmed mean, a damped recent-task EWMA, the
arithmetic average, and a confidence level. Its backwards-compatible `estimate`
is a bounded blend of the median, EWMA, and trimmed mean, so a single unusually
short or long task does not dominate the queue forecast. The dashboard includes
current elapsed and estimated remaining time, total queue ETA, and a dynamic
`START IN` estimate for each waiting task. Missing history is rendered as `--`
rather than as a fabricated estimate. The dashboard additionally reports
min/max duration, standard deviation,
coefficient of variation, completed-task throughput, recent median, and a
sample-gated faster/stable/slower trend. `START IN` and the
current task's `LEFT` use a scale-aware format: `04m 05s`, `03h 04m`, or
`2d 03h 04m`. If a running task exceeds the likely historical duration, the dashboard
falls back to P90 before declaring the remainder unknown; it never falsely
counts down to zero. Once P90 is exceeded, `LEFT` reports the overrun and queued
rows show a live `overdue` counter; later rows append their estimated offset.
The compact, `nvidia-smi`-style bordered table expands to the current terminal
width on every refresh. Task titles use the remaining space, with secondary
columns hidden progressively in narrow terminals. Cyan headings and task names,
yellow activity/timers, green completions, red failures, magenta interruptions,
and gray borders keep state legible without a dense dashboard layout.
Refresh is every two seconds after each bounded status poll.
Use `j`/`k` or arrow keys to scroll and `q`/Ctrl+C to exit. `--no-color` disables
colors; redirected output produces one plain snapshot. Offline queue snapshots
are explicitly labeled. Watching never starts tasks or triggers recovery.

Completion reports may include a Markdown `Deferred Work Ledger` section with
the declaration `Work intentionally deferred to later phases`. That section,
including nested future-work lists, is excluded from remaining-work and audit
recommendation extraction. Current-task incomplete declarations, unchecked
progress outside the ledger, and subsequent peer sections remain checked.

After a queued task is accepted as completed (including completion through a
child Cline session), the workspace extension makes three bounded cleanup
passes while the final command returns to its prompt. It disposes idle
workspace shells regardless of terminal display name, using VS Code terminal
disposal to close the terminal and its shell together.
Cleanup is Linux-only, confined to a single-root VS Code window, and requires a
shell working directory inside the workspace with no live child processes
(zombies do not keep a terminal alive). Busy, unknown, and `[keep]`-prefixed
terminals are preserved. The active terminal is preserved unless shell
integration observed it executing during the queued-task run. Cleanup errors
do not fail completed tasks; each pass has a five-second work budget (an
in-flight process check may finish afterwards). This also permits removal of
old idle workspace terminals, but does not guarantee disposal of every terminal.
VS Code does not distinguish keyboard/paste input from extension-sent input via
`isInteractedWith`. This policy can close personally used idle shells too.
Prefix a terminal name with `[keep]` to retain it, or disable the workspace
setting `cline-console.taskScanner.cleanupTerminals` (enabled by default).
No process-name-wide kill is used, and cleanup is not performed on intermediate
completion checks, queued messages, failed tasks, or interrupted tasks.

The same cleanup runs before a daemon-managed VS Code restart caused by the
YOLO consecutive-mistakes detector. It also closes all clean, unpinned file,
notebook, and text-diff tabs associated with that workspace, including restored
tabs and tabs whose document was already loaded. Dirty tabs, pinned tabs, and
paths outside the workspace are preserved. Pin a clean tab to keep it. VS Code
does not expose whether a tab or terminal was opened through typing, paste, or
agent automation, so `[keep]` remains the explicit terminal escape hatch while
pinning or unsaved editor changes are the tab safety boundaries.

When a running queued task starts a command containing interactive `sudo`, the
workspace extension shows a Zenity warning directing the user back to the VS
Code terminal. The prompt never requests, reads, stores, or forwards the sudo
password. Non-interactive `sudo -n`/`--non-interactive` commands are ignored,
and prompts for the same terminal are rate-limited to one every 30 seconds. If
Zenity is unavailable, VS Code displays a warning notification instead. This is
enabled by default through `cline-console.taskScanner.sudoZenityPrompt`.

Completion checks reconcile unchecked task-progress items against existing
evidence before requesting a full requirements review. Recognized clean CMake
rebuilds (cleanup of the same build directory followed by configuration) do not
count as implementation changes; other detected mutations still trigger fresh
verification. Unchecked work and the unchanged-correction limit remain enforced.

Relative task file paths resolve from the shell's current directory first,
then from the selected workspace if absent locally. Absolute paths are used
as given; missing-path errors list searched locations. Directory inputs and
`--newer-than` references use the same lookup. Numeric ranges remain relative
to the current directory or the directory included in their start argument.
`--workspace` selects the destination queue.

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
cline-console /repo queue list  # leading workspace path is shorthand for -w /repo
cline-console -w /repo queue add --file one.md two.md
cline-console -w /repo queue add -f replacement.md
cline-console -w /repo queue add task.md --scope /repo/src/agent
cline-console -w ~/Gordon queue add /path/to/phases/10.14 - 30
cline-console -w ~/Gordon queue add /path/to/phases/0.12.md - 0.20
cline-console -w /repo queue replace /path/to/phases/0.12 - 0.20
cline-console -w /repo queue add --dir tasks/
cline-console -w /repo queue add --from tasks/TASKS.txt
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
cline-console -w /repo queue trim 2
cline-console -w /repo --continue
cline-console -w /repo --relaunch
cline-console -w /repo queue clear
cline-console -w /repo queue clear --force

# Remove one waiting entry
cline-console -w /repo queue remove --file /absolute/path/to/task.md
cline-console -w /repo queue remove --title "Displayed title"
cline-console -w /repo queue remove --id UUID
cline-console -w /repo queue pop 3
cline-console -w /repo queue pop --id 3
```

`queue add` preserves supplied file order. A positional `START_FILE - END` range
adds matching regular sibling files inclusively in numeric order; for example,
`10.14 - 30` selects existing `10.14` through `10.30` files and skips missing
numbers. The end may be an integer (`30`) or a matching prefixed name (`0.20`).
Extensions are optional on either side, so `0.12.md - 0.20` selects
`0.12.md` through `0.20.md`. Phase tokens may also appear inside descriptive
filenames: `24.0 - 24.21` matches siblings such as
`24.0_foundation.md` and `phase_24.21_closure.txt`, regardless of their prefix,
suffix, or extension. Cross-major ranges such as `0.13 - 2.15` compare
`major.minor` version tuples and include every matching sibling in between.
The CLI prints the expanded file list before queuing.
`queue replace` accepts the same range form. Directory traversal is recursive.
Large additions use bounded concurrent file reads and linear-size IPC batching;
input order is retained without repeatedly serializing the growing batch.

`queue add --from MANIFEST` reads one task-file path per line, preserves the
manifest order, ignores blank lines and `#` comments, and resolves relative
entries from the manifest directory. `queue trim N` retains the first `N`
active positions (including a running head) and removes the remaining waiting
suffix atomically.

An explicit `queue resume` is also an execution-ownership override for the
selected workspace. If another queue currently uses the same LM Studio model,
that task is interrupted in place and the selected queue takes over after the
normal 15-second handoff delay.

The explicit short form `queue add -f FILE...` doubles as a safe fresh-start
override for an interrupted queue head. If persisted state says `running` but
Cline is not actually executing, the old record becomes `skipped`, an audit
event is stored, and the new file starts from its original prompt before the
remaining waiting items. Its previous Cline session is never resumed. A truly
running Cline task is not interrupted; in that case `-f` behaves as a normal
append. Long `--file` and positional file forms are always append-only.

Automation is ownership-scoped. The scanner, completion corrections, new-task
handoff policy, follow-up messaging, cancellation, recovery, and task status
operate only on Cline sessions durably associated with a task created or queued
through `cline-console`. A task started manually in the Cline UI may delay queue
dispatch while it is active, but cline-console does not message, cancel, resume,
classify, or otherwise manage that task.

Queues belonging to different registered VS Code workspaces run independently
and may process tasks in parallel. Each workspace must have its own active Cline
Console companion (normally its own VS Code window/extension host). Queue state,
delays, pauses, scanner policy, and recovery are isolated per workspace; the
singleton daemon only routes each command to its selected workspace.

`--scope PATH` restricts every task in an `add` or `replace` command to an
existing file or directory inside the selected workspace. The canonical scope
is stored with each queue item. While the task runs, the scanner checks Cline's
per-task edit metadata; a Cline edit outside the scope produces a same-thread
`STOP` correction naming the affected paths and is recorded in SQLite. Reads,
user edits, and text that merely mentions a path do not count as violations.

Queues are persisted across VS Code termination and Linux login/reboot cycles in
`$XDG_STATE_HOME/cline-console/queues` (normally
`~/.local/state/cline-console/queues`). Runtime sockets and registrations remain
under `$XDG_RUNTIME_DIR` and are intentionally recreated after login. Existing
runtime-only queue files are imported once when their workspace is first opened
with this version. When the same workspace is reopened, an unpaused queue
resumes its exact interrupted head only after Cline has remained continuously
idle for the configured inter-task delay (15 seconds by default). New Cline
activity resets that timer. A known running Cline session remains attached to
its queue item for completion reconciliation; only an interrupted dispatch for
which no Cline session was ever observed is safely returned to the queue front.
The CLI prompts before adding a task file already present in the active queue (or repeated
within the same batch). Only an explicit `y`/`yes` adds the duplicate; timeout,
empty input, and non-interactive use abort safely.
sorted by relative path; symbolic links are ignored. `--newer-than FILE`
includes only regular files whose modification time is strictly newer than the
reference file. Files are read immediately and their exact UTF-8 contents are
persisted in the queue.

`queue pause` lets the current item finish and stops before the next dispatch.
`queue resume` clears that persisted boundary. `queue remove` affects one
waiting item and rejects ambiguous titles; it never removes a running item.

`--continue` gently unpauses and continues the current owned Cline thread.
`--relaunch` starts the current queue item again from its original prompt in a
fresh owned session and resets that item's per-run scanner markers. Both can
ask the daemon to reopen the exact workspace before routing the request.

The daemon also watches durable non-empty queues. If an exact workspace
registration remains absent for 15 seconds, it records an unexpected close and
reopens that workspace. Reopen attempts are rate-limited and their outcomes are
stored in SQLite history.

#### Completion safety

A queued task advances only after all of these conditions hold:

1. The exact task has been observed in Cline's workspace history. Auxiliary
   session metadata cannot independently authorize completion.
2. Cline records `completion_result`; `resume_task` remains incomplete and
   blocks the queue.
3. The result remains continuously terminal for at least 15 seconds. Any
   resumed activity resets that confirmation timer.
4. The mandatory completion audit finds no incomplete task-progress counter and no
   structured remaining, outstanding, pending, future, deferred, open,
   incomplete, or partial-work declaration. A missing or truncated body is not
   sufficient by itself to classify a task as incomplete.
5. After confirmation, a separate 15-second inter-task cooldown completes.
6. Workspace activity is checked again immediately before dispatch.

Consequently, at least 30 seconds normally pass between the first terminal
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

The workspace owner can explicitly override the completion scanner for the
current running queue item with `cline-console -w /repo DONE` (equivalently,
`task done`). This CLI-only signal marks the item user-confirmed complete and is
recorded in history. Agent-generated `DONE` text is not trusted as an override;
normal workspace-idle and inter-task delay checks still protect the next dispatch.

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

#### Global task-scanner configuration

The completion scanner is intentionally active by default. Most settings use
VS Code's application scope. Reflective mode uses resource scope so it can be
set globally or overridden for one workspace. The defaults are:

| Setting | Default | Workflow effect |
| --- | ---: | --- |
| `cline-console.taskScanner.enabled` | `true` | Enables completion scanning and same-task continuation policies. |
| `cline-console.taskScanner.terminalStabilitySeconds` | `15` | Requires a stable terminal result before evaluating completion. |
| `cline-console.taskScanner.interTaskDelaySeconds` | `15` | Delays the next queued task after confirmed completion. |
| `cline-console.taskScanner.detectIncompleteCompletions` | `true` | Continues tasks whose progress or report declares unfinished work. |
| `cline-console.taskScanner.maxUnchangedCompletionCorrectionRounds` | `5` | Fails the queue item after five consecutive `STOP:` correction responses return another incomplete completion claim without detected implementation activity; implementation activity resets the streak. |
| `cline-console.taskScanner.detectTestTimeouts` | `true` | Treats an unresolved recognized test timeout as incomplete. |
| `cline-console.taskScanner.implementAuditRecommendations` | `true` | Converts concrete recommendations from audit, assessment, inspection, compliance-review, security-review, and code-review reports into same-task remediation work. |
| `cline-console.taskScanner.requirePostImplementationReport` | `true` | Requires a durable post-remediation report covering changes, validation, residual risk, and blockers. |
| `cline-console.taskScanner.verifyCompletionCriteria` | `true` | Runs a final same-thread criteria verification and repeats it only after detected implementation changes. |
| `cline-console.taskScanner.completionConfidenceThreshold` | `90` | Accepts a verification pass that reports `COMPLETION_CONFIDENCE: N%` at or above this evidence-based threshold, even when the pass made justified code changes. |
| `cline-console.taskScanner.maxCompletionVerificationRounds` | `3` | Bounds verification loops: after three requested passes, a completion with no explicit incomplete-work indicators may proceed even when validation cleanup or further implementation activity was detected. The fallback is recorded as `bounded_round_limit`. |
| `cline-console.taskScanner.reflective` | `false` | Requests a same-thread implementation reflection and stores its completion in history. |
| `cline-console.taskScanner.restartOnYoloFailure` | `true` | Requests guarded workspace recovery after Cline explicitly stops for three consecutive YOLO-mode mistakes. |
| `cline-console.taskScanner.waitForLmStudio` | `true` | Holds recovered and newly dispatched queue work until the configured LM Studio endpoint accepts TCP connections. |
| `cline-console.taskScanner.lmStudioHost` | `127.0.0.1` | Host checked by the LM Studio readiness gate. |
| `cline-console.taskScanner.lmStudioPort` | `1234` | Port checked by the LM Studio readiness gate. |
| `cline-console.taskScanner.singleQueuePerLmStudioModel` | `true` | Allows one active console-owned queue per loaded LM Studio model; a newly resumed competitor presses Cancel in the previous task thread, marks it interrupted, and automatically resumes that same thread 15 seconds after the winner releases the model. |

For queues sharing a model, a manual **Resume Task** is an explicit execution
override: its exact workspace becomes the arbitration winner and the competing
console-owned task is cancelled into `interrupted`. A manual **Cancel** releases
the lease; the most recently preempted online queue resumes after the configured
15-second handoff delay. Intermediate completion checks retain the lease until
the queue really advances. Resuming a queue whose owned Cline thread is showing
**Resume Task** actively continues that exact thread instead of merely restarting
the passive completion monitor. YOLO recovery opens the exact workspace in a new VS
Code window instead of reusing whichever window happened to be most recent.

With the defaults, an audit is not considered finished merely because it has
produced findings and recommendations. Concrete recommendations are returned to
the same Cline task for implementation, subject to the original task's authority
and safety constraints. The scanner tracks normalized recommendation text so an
unchanged recommendation list is not issued repeatedly. Change these settings
in VS Code's User Settings and reload the extension host for a running queue to
adopt the new values.

The completion-verification gate issues one final request to check the original
criteria against concrete evidence. A read-only verification completion passes
the gate. If that verification writes or edits files, or runs a recognized
mutating command, the scanner issues the verification request once more against
the changed implementation. This bounded rule continues until a verification
pass makes no implementation changes; the normal 15-second inter-task pause then
applies.

Reflective mode can be enabled in VS Code User Settings for every workspace or
overridden in Workspace Settings. A queued task can override either setting:

```bash
cline-console -w ~/Gordon queue add phase.md --reflective true
cline-console -w ~/Gordon queue add phase.md --reflective false
```

After ordinary completion and required remediation, the scanner asks the same
Cline thread for an evidence-based report of difficulties, obstacles, blockers,
failed approaches, tradeoffs, surprises, and lessons. It requests
`.cline-console/reflections/<queue-id>.md`; the final reflective completion is
also stored as a `reflection_completed` SQLite history event when writing a
workspace report is inappropriate or unavailable.

All human-readable command output is colorized when stdout is an interactive
terminal. `--no-color`, `NO_COLOR`, `TERM=dumb`, redirected output, and `--json`
remain free of ANSI escape sequences.

If Cline records an explicit provider context-window overflow error, the worker
sends `/compact` to the same task, waits for compaction processing, and then
asks the task to continue from where it stopped. Each persisted overflow error
is handled once. Ordinary context-window usage telemetry does not trigger
automatic compaction.

The workspace policy watcher explicitly forbids Cline's `new_task` handoff for
cline-console-owned tasks. Manually started Cline tasks remain unmanaged. It
selects the exact requesting Cline session and answers each persisted
handoff once with a direct same-thread completion instruction containing the
proposed handoff context. It never dispatches that context as a new task.
The watcher checks recent exact-workspace predecessor sessions as well as the
latest session, so a fast Cline task rollover cannot hide the request. A parked
latest handoff remains actionable across long pauses; stale predecessor
handoffs are ignored. Compaction remains reserved for an actual context-window
overflow. Each send is bounded by a timeout, and the watcher verifies that
Cline persisted the same-thread instruction before recording the handoff as
handled. Failed or misdirected delivery is retried, while verified handled
markers survive extension restarts.

All automatic task-bound messages use the same rule: the workspace queue
serializes selection and delivery, verifies durable ownership, selects the
intended session explicitly, and applies a bounded timeout. A correction or
verification is never sent merely to whichever Cline panel happens to be
active.

Status reconciliation also distinguishes evidence of a live run from stale UI
metadata. A live session PID is authoritative. UI-only activity older than 15
minutes without a terminal, waiting, or failure record is reported as no task
running, preventing an abandoned UI record from blocking the queue forever.
Persisted structured and text variants of Cline's YOLO stop/failure messages are
reported as failures until a real retry begins; source code and tool payloads
that merely quote those words do not trigger the detector.

When `restartOnYoloFailure` is enabled, that exact three-mistake failure also
creates a private recovery request for the user service. The daemon validates
the registered workspace and the exact VS Code extension-host PID against
`/proc` before sending `SIGTERM`, uses bounded `SIGKILL` only if that process
does not exit, and asks VS Code to reopen the same workspace. It never runs a
broad `pkill` or targets unrelated VS Code windows. Requested, started,
completed, and failed recovery stages are retained as SQLite history events;
the queued task remains pending and follows the normal 15-second idle recovery
gate after the workspace companion reconnects.
If Cline creates a replacement session during recovery, the scanner adopts it
only when both the canonical workspace and complete original prompt match and
the replacement is newer than the failed session. A completed or already-active
replacement suppresses stale `continue` delivery to its predecessor.

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

The database runs through the supported `better-sqlite3` driver rather than
Node's experimental `node:sqlite` API. Connections use a five-second busy
timeout, bounded WAL checkpoints, and an open-time `quick_check`; shutdown
performs a passive checkpoint before closing. This avoids the Node SQLite
experimental warning while retaining the existing schema and database path.

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
local routing socket. The service runs independently of invoking terminals and
uses `Restart=on-failure`. Transient file-log failures fall back to the systemd
journal instead of terminating the daemon. Its unit applies a private umask,
explicit journal output, and a bounded stop timeout. Detached queue workers
contain unexpected failures and retry after a bounded delay rather than
creating an unhandled rejection or tight loop. `service run` is intended only
for foreground diagnostics.

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
Persisted work is shown as magenta `interrupted`, rather than `running`, while
the VS Code companion is offline or its Cline task is waiting or unavailable.
Observed terminal tasks use `completed` or `failed`, and an explicit `DONE`
override remains visible as `closed`. The state returns to `running` when live
execution resumes; internal recovery records are preserved throughout.
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
will say `VS Code companion: offline` and render any current item as
`interrupted`; mutations require the workspace companion to reconnect.

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

- [Flow principles and state machines](docs/flow-principles-and-state-machine.md)
  defines the normative queue, recovery, and completion-scanner workflow.

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
