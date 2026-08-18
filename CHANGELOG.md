# Changelog

All notable changes to Cline Console are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

- Publication documentation and release validation.
- Fixed queue discovery after VS Code restarts by listing persisted workspace
  queues even while their companion extension is offline.
- Skip a running queue item when its exact task disappears from Cline's
  workspace history, allowing the next queued task to advance immediately.
- Expire stale in-memory `submitted` markers after the Cline handoff window so
  completed or absent workspace tasks are not reported as active.
- Restore `tasks` as the preferred task-listing command; retain `task list` as
  a deprecated compatibility alias.
- Retry explicit workspace registration briefly during VS Code startup instead
  of returning a false workspace-not-registered error during activation.
- Make scoped `queue clear` enforce removal of waiting and running queue items
  and delete only their exact workspace/prompt matches from Cline history.
- Add scoped `workspace clear` to remove the selected workspace queue and every
  Cline history task owned by that exact workspace.
- Require a Cline terminal signal to remain stable for at least 60 seconds
  before completing a queued task; reset the wait if execution resumes.

## [0.13.0] - 2026-08-11

- Added `--newer-than REFERENCE_FILE` for directory-based queue add and replace
  batches.
- Filter by strict file modification time while preserving deterministic
  relative-path ordering.

## [0.12.1] - 2026-08-11

- Added a section-1 manual page for the canonical CLI grammar, queue behavior,
  compatibility aliases, files, environment, and examples.
- Registered the manual in npm package metadata for global installation.

## [0.12.0] - 2026-08-11

- Reorganized the CLI into `task`, `queue`, `workspace`, and `service`
  resource/action commands.
- Added canonical batch `queue add` and `queue replace`, explicit file/title/ID
  removal selectors, and `queue add --resume`.
- Added global `--no-color`, `--timeout`, `--version`, and short workspace/version
  options while retaining pre-0.12 commands as deprecated compatibility aliases.

## [0.11.2] - 2026-08-11

- Align queue table columns using visible uncolored widths.
- Add a horizontal separator between queue headers and entries.

## [0.11.1] - 2026-08-11

- Show the exact queued source path in `tasks` when the Cline prompt matches a
  persisted queue item.
- Prefer meaningful phase headings over separator boilerplate for task titles.
- Recheck workspace activity after an idle stabilization interval and again
  after cooldown to prevent a resumed task racing the next queue dispatch.

## [0.11.0] - 2026-08-10

- Added a persisted 30-second cooldown between completion/failure of one queued
  task and dispatch of the next queued task.
- Keep queued messages immediate and recheck pause/clear/replacement state after
  the cooldown before dispatch.

## [0.10.1] - 2026-08-10

- Make `queue clear` remove stale `running` queue entries when reconciled Cline
  task status is not active.
- Continue preserving running queue entries when `tasks` reports an active task
  or status reconciliation is unavailable.

## [0.10.0] - 2026-08-10

- Added standalone workspace `resume` command.
- Allow `resume -f ...` and `resume -d ...` to append task files before clearing
  the persisted queue pause; without file arguments, resume the existing FIFO.

## [0.9.0] - 2026-08-10

- Prompt before `add` when the workspace task is incomplete and waiting.
- Allow the user to restart the incomplete task from its original prompt, skip
  it for the next queue dispatch, or abort safely after 30 seconds.

## [0.8.1] - 2026-08-10

- Report incomplete tasks ending at Cline's `resume_task` prompt as `waiting`
  instead of `running`.
- Keep waiting tasks non-terminal so queues do not advance prematurely.

## [0.8.0] - 2026-08-10

- Added workspace-scoped `queue pop` to remove one waiting item by exact source
  path or displayed first-line title.
- Reject ambiguous titles and attempts to remove a currently running item.

## [0.7.0] - 2026-08-10

- Added persisted workspace queue pause state.
- Added `queue pause`, which lets the running item finish and prevents the next
  waiting item from dispatching until `queue resume`.

## [0.6.0] - 2026-08-10

- Added workspace-scoped `tasks stop` using Cline's normal cancellation path.
- Added `tasks reload` to restart the latest exact-workspace task from its
  original full prompt in Cline history.

## [0.5.0] - 2026-08-10

- Added batch `new -f ...` and `new -d ...` queue replacement.
- Added explicit queue resume and clear operations scoped to one workspace.
- Queue replacement and clearing preserve any currently running task.
- Added automatic ANSI colors for interactive terminal status and queue output,
  with plain output for JSON, pipes, `NO_COLOR`, and dumb terminals.

## [0.4.1] - 2026-08-10

- Added global `cline-console queue` and `queue --json` views across all
  registered workspaces while retaining the scoped `--workspace` form.

## [0.4.0] - 2026-08-10

- Added `queue` and `queue --json` to inspect each workspace's active FIFO
  entries without printing full prompt bodies.

## [0.3.9] - 2026-08-10

- Fixed persistent FIFO advancement by matching the exact workspace and full
  prompt in Cline task history and waiting for `completion_result`.
- Added task titles derived from the first prompt line.
- Reconciled active/completed state from Cline workspace task history.
- Added queued follow-up messages and active-task collision handling.
- Added the singleton user service and per-workspace routing.

## [0.2.0] - 2026-08-09

- Added multi-workspace discovery and deterministic selection.
- Added service status, workspace listing, task status, and cancellation.

## [0.1.0] - 2026-08-09

- Initial terminal-to-VS-Code bridge using Cline's public Legacy extension API.

[Unreleased]: https://github.com/bvrznski/cline-console/compare/v0.13.0...HEAD
[0.13.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.13.0
[0.12.1]: https://github.com/bvrznski/cline-console/releases/tag/v0.12.1
[0.12.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.12.0
[0.11.2]: https://github.com/bvrznski/cline-console/releases/tag/v0.11.2
[0.11.1]: https://github.com/bvrznski/cline-console/releases/tag/v0.11.1
[0.11.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.11.0
[0.10.1]: https://github.com/bvrznski/cline-console/releases/tag/v0.10.1
[0.10.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.10.0
[0.9.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.9.0
[0.8.1]: https://github.com/bvrznski/cline-console/releases/tag/v0.8.1
[0.8.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.8.0
[0.7.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.7.0
[0.6.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.6.0
[0.5.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.5.0
[0.4.1]: https://github.com/bvrznski/cline-console/releases/tag/v0.4.1
[0.4.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.4.0
[0.3.9]: https://github.com/bvrznski/cline-console/releases/tag/v0.3.9
[0.2.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.2.0
[0.1.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.1.0
