# Security policy

## Supported versions

Security fixes are provided for the latest published minor version. This project
is currently pre-1.0 and its compatibility surface may change between minors.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Use GitHub's private
security advisory flow for `bvrznski/cline-console`. Include the affected
version, reproduction steps, impact, and any suggested mitigation.

## Security model

Cline Console accepts commands from the local user account only:

- It creates no TCP listener.
- Runtime directories are mode `0700`; sockets and registrations are mode
  `0600`.
- One singleton user service routes requests to exact registered workspaces.
- Prompts and follow-up message bodies are excluded from logs.
- Cline remains responsible for approvals, provider credentials, tools,
  terminals, checkpoints, and task execution.

Anyone able to execute processes as the same OS user can generally access that
user's local sockets and VS Code data. Cline Console does not claim to isolate
mutually untrusted processes running under one user account.
