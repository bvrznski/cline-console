# Publishing checklist

This document prepares releases; it does not authorize publishing credentials,
tags, pushes, Marketplace uploads, or npm publication.

## One-time setup

1. Create `https://github.com/bvrznski/cline-console`.
2. Enable private vulnerability reporting and branch protection.
3. Create the `bvrznski` publisher in the VS Code Marketplace.
4. Configure npm and Marketplace credentials outside the repository.
5. Confirm the Cline trademark disclaimer and Marketplace naming are acceptable.

## Release preparation

1. Choose a semantic version and update `package.json`, `package-lock.json`, and
   `src/common/version.ts` together.
2. Move relevant entries from `Unreleased` in `CHANGELOG.md` into the release.
3. Verify documentation and supported Cline/VS Code/Node versions.
4. Run:

   ```bash
   npm ci
   npm run verify:release
   npm run package
   npm pack --dry-run
   ```

5. Inspect the VSIX with `vsce ls --tree`; it must not contain source tests,
   local prompts, credentials, logs, old VSIX files, or runtime queue data.
6. Install the VSIX into a clean VS Code profile and validate new, send, add,
   queue advancement, tasks, cancellation, and multi-workspace selection.
7. Verify install and rollback instructions on the supported Linux target.

## Publication

After review and explicit authorization:

```bash
npm publish
vsce publish --packagePath cline-console-<version>.vsix
```

Create an annotated Git tag and GitHub release containing the same VSIX and
release notes. Never commit or print npm tokens or Marketplace PATs.

## Rollback

- npm versions are immutable; deprecate a defective version and publish a fix.
- Unpublish a Marketplace version only when policy and impact justify it.
- Keep the prior verified VSIX available for manual reinstall.
- Stop or uninstall the local service with `cline-console service stop` or by
  disabling `cline-console.service` before removing the CLI.
