# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-16

### Added

- Emulation of the Forge storage REST API used by `@forge/kvs`: key-value store,
  secrets, Custom Entities, index queries, filters, transactions and batches.
- Custom Entity schema loaded from `manifest.yml` and validated against the
  documented Forge limits.
- Value validation: keys, size, depth, attribute types, 32-bit integers, float
  range, empty strings, index value sizes.
- TTL, metadata fields, `keyPolicy` and `returnValue` set options.
- Test API: seeding, snapshots, reset, fault injection, request log, clock.
- `installKvsEmulator` and `useKvsEmulator` for Vitest, Jest and other runners.
- ESM and CommonJS builds with TypeScript declarations.

[0.1.0]: https://github.com/NoxVoidSoftware/forge-kvs-emulator/releases/tag/v0.1.0
