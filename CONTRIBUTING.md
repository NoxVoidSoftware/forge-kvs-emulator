# Contributing

Thanks for helping improve forge-kvs-emulator.

## Setup

```sh
npm ci
npm run verify   # typecheck, lint, format check, tests with coverage, build, package checks
```

## Guidelines

- **Fidelity first.** The emulator should accept what Forge accepts and refuse
  what Forge refuses. When you change behaviour, link the Forge documentation or
  describe what Forge returned (operation, data, status, error code).
- **Documented vs approximated.** Error codes Forge documents go into
  `ErrorCode` as is. Behaviour Forge does not document is marked as an
  approximation in `src/errors.ts` and the README.
- **Tests go through the real client.** Prefer tests that call `@forge/kvs`
  against an installed emulator over tests of internal functions.
- Keep coverage above the thresholds in `vitest.config.ts`.
- Add an entry under "Unreleased" in `CHANGELOG.md`.

## Releasing (maintainers)

1. Update `version` in `package.json` and move the changelog entries under the
   new version.
2. Commit, tag `vX.Y.Z` and push the tag. The release workflow verifies the
   package and publishes it to npm with provenance.
