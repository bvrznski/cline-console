# Changelog

All notable changes to Cline Console are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

- Publication documentation and release validation.

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

[Unreleased]: https://github.com/bvrznski/cline-console/compare/v0.3.9...HEAD
[0.3.9]: https://github.com/bvrznski/cline-console/releases/tag/v0.3.9
[0.2.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.2.0
[0.1.0]: https://github.com/bvrznski/cline-console/releases/tag/v0.1.0
