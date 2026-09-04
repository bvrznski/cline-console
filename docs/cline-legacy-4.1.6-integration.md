# Cline Legacy 4.1.6 integration

Status: implemented against the locally installed 4.1.7 Legacy bundle; 4.1.6 runtime acceptance remains unverified because 4.1.6 was not installed on this machine.

## Inspected installation

- Directory: `~/.vscode/extensions/saoudrizwan.claude-dev-4.1.7`
- Extension identifier: `saoudrizwan.claude-dev`
- Manifest version: `4.1.7`
- Loader entry: `extension.js`
- Legacy entry: `legacy/dist/extension.js`
- Legacy manifest: `legacy/package.json`
- Webview bundle: `legacy/webview-ui/build/assets/index.js`

The top-level rollout loader activates either `next/dist/extension.js` or `legacy/dist/extension.js` and returns the selected bundle's activation result.

## Discovered activation API

Legacy activation returns the object built by minified symbol `vEc(controller)` in `legacy/dist/extension.js` (byte offset approximately 20,988,691 in the installed artifact):

- `startNewTask(prompt, images?)`
- `sendMessage(message, images?)`
- `pressPrimaryButton()`
- `pressSecondaryButton()`

`startNewTask` calls `controller.clearTask()`, posts state, opens the Cline view, and calls `controller.initTask(prompt, images)`. `sendMessage` calls `controller.task.handleWebviewAskResponse("messageResponse", message, images)` when a task exists. These are public activation exports available through `vscode.extensions.getExtension("saoudrizwan.claude-dev").activate()`.

Before calling `startNewTask`, the adapter explicitly shows the sidebar, opens the contributed view container through VS Code's canonical `workbench.view.extension.<container-id>` command, focuses `<extension-name>.SidebarProvider`, and invokes Cline's own `cline.focusChatInput` command. For stable Cline the container and view commands resolve to `workbench.view.extension.claude-dev-ActivityBar` and `claude-dev.SidebarProvider.focus`. Cline's internal test helper uses the older `workbench.view.<container-id>` form, but that did not reveal a fully closed sidebar in the tested VS Code layout.

## Commands

The installed manifest registers `cline.plusButtonClicked`, `cline.mcpButtonClicked`, `cline.marketplaceButtonClicked`, `cline.historyButtonClicked`, `cline.accountButtonClicked`, `cline.settingsButtonClicked`, `cline.addToChat`, `cline.addTerminalOutputToChat`, `cline.focusChatInput`, and other editor/dev commands. Of these, `cline.plusButtonClicked` is relevant: the Legacy handler calls `controller.clearTask()`, `controller.postStateToWebview()`, and opens the Cline view.

There is no contributed `cline.cancelTask` command.

## Controller and task path

The minified Legacy controller contains `initTask(task, images, files, historyItem, taskSettings)`. It clears the previous task, resolves the primary workspace root, constructs the task object, and calls `task.startTask(...)`. The gRPC `TaskService` contains `newTask`, `cancelTask`, `clearTask`, history, and show-task handlers. Webview messages enter through `grpc_request` and `grpc_request_cancel` in the webview provider.

The public API is preferred over importing minified internals or replaying gRPC frames. The controller instance itself is not returned by activation, and those private routes are therefore deliberately not used.

The terminal does not connect to workspace companions directly. A singleton `systemd --user` service owns `service.sock`, resolves the exact workspace registration, and forwards the typed request to that VS Code window. Per-workspace sockets remain companion endpoints, not independent control services.

## Chosen and rejected strategies

- Chosen for new/follow-up: Strategy A, public activation API.
- Chosen for cancel: Strategy B, registered `cline.plusButtonClicked`, because its handler uses Cline's normal `clearTask` path.
- Rejected: internal bundle imports. Minified symbols are unstable and a second `require` would not reliably expose the activated singleton.
- Rejected: webview protocol injection. The public API reaches the same controller directly.
- Rejected: clipboard, keyboard, Electron, browser, and standalone CLI automation.

Status is not exported by the activation API. The singleton service and companion therefore inspect Cline's persisted `taskHistory.json`, select the newest entry whose `cwdOnTaskInitialization` exactly matches the workspace, and inspect that task's `ui_messages.json` records. `completion_result` is terminal, `resume_task` is waiting, and unresolved persisted failures remain failed. A live PID-backed session record overrides an older UI timestamp. UI-only nonterminal activity older than 15 minutes is stale and reconciles to no running task rather than blocking the workspace indefinitely. Timestamped session metadata remains a fallback. This avoids stale `idle` session files, dead `running` processes, abandoned UI activity, and stale bridge `submitted` markers. The Cline task-history identifier is reported as the task ID.

The workspace policy scanner separately searches up to 50 recent exact-workspace history entries for unresolved `new_task` asks. This covers the race in which Cline selects a successor before the predecessor handoff is scanned. The newest workspace task may remain parked for longer than the normal stale-activity window and still be actionable, while old predecessor handoffs are age-bounded. The scanner selects the requesting task, sends the same-thread continuation, and waits for that exact task's UI history to persist the instruction before it records the marker as handled. A timeout or a send routed to the wrong task remains unhandled and is retried.

YOLO-mode stops are recognized from both plain and structured persisted error records, including automatic-execution-stop and consecutive-mistake wording. The detector ignores quoted source/tool payloads and clears an unresolved failure only after actual user feedback followed by a new API request, or a terminal completion.

## Queue completion signal

The installed 4.1.7 runtime writes VS Code task session metadata under `~/.cline/data/sessions/<session-id>/<session-id>.json`. Inspected records contain `source: "vscode"`, `workspace_root`, the exact `prompt`, `pid`, `started_at`, `status`, and `exit_code`. Observed values include `running`, `idle`, `completed`, and `failed`. The queue matches workspace, exact prompt, and dispatch time, waits at five-second intervals, and advances only after the active run ends. Live running sessions owned by an existing process are allowed to finish before the first queued item is submitted.

`cline-console tasks` reads this metadata rather than trusting the adapter's last submitted state. `cline-console send` sends immediately to an `idle`/completed task and persists the message in the workspace FIFO when the task is `running`; the queued follow-up is delivered to the same session after its current run ends.

This completion metadata was verified in installed 4.1.7. A 4.1.6 installation must be checked for the same session files; without them the queue remains safely waiting rather than dispatching tasks concurrently.

## Compatibility risk

The public method names are substantially safer than minified controller access, but they are not declared in the Cline manifest and can change. Capability detection checks the object at runtime and fails explicitly if required methods are missing. A future adapter should target a documented Cline API or stable command/gRPC contract.

## Manual integration checklist

1. Install the companion VSIX and reload a VS Code window with Cline Legacy 4.1.6.
2. Open Cline once and verify the configured LM Studio provider normally.
3. Run `cline-console capabilities`; verify new task and follow-up are `yes`.
4. Create `/tmp/cline-test.md` containing the acceptance prompt from the project specification.
5. From the open workspace run `cline-console new -f /tmp/cline-test.md`.
6. Verify the task appears in Cline UI/history and uses the existing provider and approval behavior.
7. Run `cline-console --workspace <workspace> tasks` after completion and verify it reports `completed` rather than `active`.
8. Run `cline-console --workspace <workspace> send "Report the exact file content."` against the completed task and verify the follow-up appears immediately.
9. While that follow-up is running, issue another `send` and verify it reports that the message was queued, then appears after the current run finishes.
8. Run `cline-console cancel` during a disposable task and verify Cline aborts through its normal new-task transition.

No live 4.1.6 graphical acceptance test was claimed during this implementation.
