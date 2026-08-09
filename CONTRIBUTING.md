# Contributing

Thank you for improving Cline Console.

## Development setup

Requirements:

- Linux with systemd user services
- Node.js 18 or newer
- VS Code 1.85 or newer
- Cline Legacy 4.1.7 for the currently verified integration

```bash
npm ci
npm test
npm run package
```

Install a development build with:

```bash
code --install-extension cline-console-<version>.vsix --force
npm link
cline-console service install
```

Reload each target VS Code window after replacing the extension.

## Change expectations

- Keep Cline as the execution engine; do not add a standalone agent loop.
- Preserve exact prompt bytes after UTF-8 decoding.
- Keep IPC local, authenticated by filesystem permissions, and free of TCP.
- Isolate Cline-version-specific behavior under `src/integrations/cline/`.
- Add focused tests for protocol, queue, status, and workspace-selection changes.
- Never log prompt or follow-up message bodies.
- Update the README, CLI reference, architecture document, and changelog when
  behavior or compatibility changes.

## Pull requests

Before opening a pull request, run:

```bash
npm run verify:release
npm run package
```

Describe the user-visible behavior, compatibility impact, tests performed, and
whether live VS Code/Cline validation was completed. Automated tests do not by
themselves prove graphical or live extension behavior.
