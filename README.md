# forge-kvs-emulator

[![CI](https://github.com/NoxVoidSoftware/forge-kvs-emulator/actions/workflows/ci.yml/badge.svg)](https://github.com/NoxVoidSoftware/forge-kvs-emulator/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@noxvoid-software/forge-kvs-emulator.svg)](https://www.npmjs.com/package/@noxvoid-software/forge-kvs-emulator)
[![license](https://img.shields.io/npm/l/@noxvoid-software/forge-kvs-emulator.svg)](LICENSE)

In-memory emulator of the [Atlassian Forge](https://developer.atlassian.com/platform/forge/) **Key-Value Store**
and **Custom Entity Store**, for unit and integration tests.

Most Forge storage mocks replace `@forge/kvs` with a hand-written fake, which drifts from the real client and
accepts data Forge would refuse. This emulator works one level lower: it answers the storage **REST API** that
`@forge/kvs` talks to. Your tests run the **real** `@forge/kvs` package (query builders, filters, transactions,
error mapping), and the emulator enforces the Custom Entity schema from your **`manifest.yml`**.

```ts
import { kvs, WhereConditions } from '@forge/kvs';
import { installKvsEmulator } from '@noxvoid-software/forge-kvs-emulator';

const { emulator } = installKvsEmulator({ manifestPath: 'manifest.yml' });

await kvs.entity('order').set('o-1', { customerId: 'c-1', status: 'open', createdAt: '2026-01-01' });
const { results } = await kvs
  .entity('order')
  .query()
  .index('by-customer', { partition: ['c-1'] })
  .where(WhereConditions.beginsWith('2026'))
  .getMany();

await kvs.entity('order').set('o-2', { customerId: 'c-1', status: '' });
// ForgeKvsAPIError: Value for attribute "status" cannot be empty.  (code: EMPTY_PROPERTY_VALUE)
```

## Why

- **Catches what Forge would reject, before you deploy.** Empty strings in entity attributes, 33-bit integers,
  undeclared attributes or indexes, wrong partition sizes, oversized values, invalid keys.
- **No drift.** The real `@forge/kvs` client runs in your tests, so new client features and its error handling are
  exercised exactly as in production.
- **Realistic concurrency.** Every request resolves on a later tick, so optimistic-concurrency code and races
  behave like they do against a network service.
- **Test tooling built in.** Seeding, snapshots, fault injection, a request log and a controllable clock for TTLs.

## Install

```sh
npm install --save-dev @noxvoid-software/forge-kvs-emulator
```

Requires Node.js 20 or later (Forge runs Node.js 22 and 24). `@forge/kvs` is the peer you already depend on (any 1.x or 2.x version).

## Usage

### Vitest

```ts
import { afterAll, beforeEach, expect, it } from 'vitest';
import { kvs } from '@forge/kvs';
import { useKvsEmulator } from '@noxvoid-software/forge-kvs-emulator';

// One emulator per test file, emptied before each test.
const emulator = useKvsEmulator({ manifestPath: 'manifest.yml' }, { beforeEach, afterAll });

it('saves the order', async () => {
  await saveOrder({ id: 'o-1', customerId: 'c-1' }); // your code, using @forge/kvs
  expect(emulator.getEntity('order', 'o-1')).toMatchObject({ customerId: 'c-1' });
});
```

### Jest

```ts
import { kvs } from '@forge/kvs';
import { useKvsEmulator } from '@noxvoid-software/forge-kvs-emulator';

const emulator = useKvsEmulator({ manifestPath: 'manifest.yml' }, { beforeEach, afterAll });
```

Jest projects that transpile to CommonJS can `require('@noxvoid-software/forge-kvs-emulator')`; the package ships both ESM and CJS.

### Any runner, or manual control

```ts
import { installKvsEmulator } from '@noxvoid-software/forge-kvs-emulator';

const { emulator, uninstall } = installKvsEmulator({ manifestPath: 'manifest.yml' });
// ... tests ...
emulator.reset(); // between tests
uninstall(); // when done
```

### How it connects

In production, the Forge runtime provides `globalThis.__forge_fetch__`, and `@forge/kvs` sends each storage
operation through it as `POST /api/v1/...`. `installKvsEmulator` puts a function there that answers storage
requests and passes every other request type to the function that was installed before, so existing
`@forge/api` mocks keep working. It does not matter whether `@forge/kvs` is imported before or after installing.

Do **not** `vi.mock('@forge/kvs')` / `jest.mock('@forge/kvs')` when using the emulator: the point is to run the
real package.

## Options

```ts
installKvsEmulator({
  manifestPath: 'manifest.yml', // entities from app.storage.entities
  entities: [], // or/and entity definitions in manifest format
  allowUnknownAttributes: false, // refuse attributes the manifest does not declare
  latency: 'tick', // 'tick' (default) | milliseconds | 0
  now: () => Date.now(), // clock for TTL and metadata
  limits: { maxBatchItems: 25 }, // override any limit, see below
  recordRequests: true // keep a request log in emulator.requests
});
```

## Test API

| Method                                                      | Purpose                                                                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `getValue(key)`, `getSecret(key)`, `getEntity(entity, key)` | Read stored data directly (synchronously, no request recorded)                                           |
| `listKeys()`, `listEntities(entity)`                        | Everything stored, ordered by key                                                                        |
| `seedValue`, `seedSecret`, `seedEntity`                     | Insert data; validated like a real write                                                                 |
| `snapshot()`, `restore(snapshot)`                           | Save and restore the whole store                                                                         |
| `reset()`                                                   | Empty the store, request log, faults and clock offset                                                    |
| `failNext(matcher, fault, { times })`                       | Make matching requests fail, e.g. `failNext('entity.set', { code: 'RATE_LIMIT_EXCEEDED', status: 429 })` |
| `requests`                                                  | Log of handled requests: `{ operation, body, status, code? }`                                            |
| `advanceTime(ms)`                                           | Move the internal clock (TTL expiry)                                                                     |
| `fetch(path, init)`                                         | The emulated REST endpoint, if you wire the transport yourself                                           |

Operation names in the log and for `failNext` are the API path after `/api/v1/` with dots: `get`, `set`, `delete`,
`query`, `secret.get`, `entity.set`, `entity.query`, `batch.set`, `transaction`, ...

## What is emulated

| Area              | Supported                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| Key-value store   | `get`, `set`, `delete`, `query().where('key', beginsWith)` with cursor paging, metadata fields, TTL             |
| Set options       | `keyPolicy: 'FAIL_IF_EXISTS'`, `returnValue: 'PREVIOUS' \| 'LATEST'`, `ttl`                                     |
| Secrets           | `getSecret`, `setSecret`, `deleteSecret`, stored apart from key-value data                                      |
| Custom Entities   | `get`, `set`, `delete`, index queries with partitions, `where`, `filters` (and / or), `sort`, `limit`, `cursor` |
| Transactions      | `set`, `delete`, `check` with conditions; all conditions are evaluated before anything is written               |
| Batches           | `batchSet`, `batchGet`, `batchDelete` with per-key `successfulKeys` / `failedKeys`                              |
| Schema (manifest) | Entity / attribute / index names, attribute types, index attribute rules, 20 entities, 50 attributes, 7 indexes |

### Validation and limits

Defaults follow the Forge documentation; every limit can be overridden with `limits`.

| Rule                                   | Default                                                              |
| -------------------------------------- | -------------------------------------------------------------------- |
| Key: not empty, at most 500 characters | `maxKeyLength: 500`                                                  |
| Key characters                         | `a-z A-Z 0-9 : . _ - #` and space, not only spaces                   |
| Value size / nesting depth             | `maxValueBytes: 245760` (240 KiB), `maxDepth: 31`                    |
| `integer` attributes                   | 32-bit signed                                                        |
| `float` attributes                     | 0, or magnitude between 1E-130 and 1E+126                            |
| `string` attributes                    | not empty and not only whitespace                                    |
| Index values (combined)                | range 900 B, partition 1700 B                                        |
| Query page size                        | `defaultQueryLimit: 10`, `maxQueryLimit: 100` (clamped)              |
| Batch / transaction size               | unlimited unless `maxBatchItems` / `maxTransactionOperations` is set |

### Error codes

Errors reach your code as the real `ForgeKvsAPIError` with a `code`. Codes Forge documents or is known to return
are used as is: `KEY_NOT_FOUND`, `EMPTY_KEY`, `INVALID_KEY`, `KEY_TOO_LONG`, `MAX_SIZE`, `MAX_DEPTH`,
`INVALID_ENTITY_VALUE`, `EMPTY_PROPERTY_VALUE`, `INVALID_ENTITY_TYPE`.

For situations Forge does not document, the emulator uses descriptive codes of its own: `ENTITY_NOT_FOUND`,
`UNKNOWN_ENTITY_ATTRIBUTE`, `INVALID_INDEX`, `INDEX_VALUE_TOO_LARGE`, `KEY_ALREADY_EXISTS`,
`CONDITION_CHECK_FAILED`, `INVALID_TRANSACTION`, `INVALID_VALUE`, `INVALID_CURSOR`, `INVALID_REQUEST`,
`BATCH_TOO_LARGE`. They are exported as `ErrorCode`. Assert that such operations fail, rather than on these
exact codes, if your code must match Forge byte for byte.

### Behaviour worth knowing

- **Sparse indexes**: an entity missing an index's partition or range attribute is not part of that index.
- **Conditions on missing entities** behave as on an entity without attributes: `notExists()` holds, everything
  else fails. This is how "create only if absent" is usually written.
- **Undeclared attributes** are refused by default (stricter than necessary on purpose: it catches manifest drift).
  Set `allowUnknownAttributes: true` to accept them.
- **Values are copied** in and out (JSON round trip), so mutating an object after `set` or after `get` never
  changes what is stored.

## Not a production database

The emulator keeps everything in memory, has no persistence and implements the storage API as documented, not
its internal performance characteristics. It is meant for tests and local tooling.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). If Forge behaves differently from the
emulator in a case you hit, please open an issue with the operation, the data and the error Forge returned.

## License

[MIT](LICENSE) © NoxVoid Software. Not affiliated with or endorsed by Atlassian. Atlassian and Forge are trademarks
of Atlassian.
