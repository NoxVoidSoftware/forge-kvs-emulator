/**
 * forge-kvs-emulator
 *
 * In-memory emulator of the Atlassian Forge KVS and Custom Entity Store for
 * unit and integration tests. It emulates the storage REST API underneath
 * `@forge/kvs`, so the real client library runs unchanged, and it enforces
 * the Custom Entity schema from manifest.yml.
 */

export {
  KvsEmulator,
  createKvsEmulator,
  type EmulatorSnapshot,
  type FetchLike,
  type InjectedFault,
  type KvsEmulatorOptions,
  type OperationMatcher,
  type RecordedRequest,
  type StoredRecord
} from './emulator.js';
export { installKvsEmulator, useKvsEmulator, type InstalledKvsEmulator, type LifecycleHooks } from './install.js';
export { EmulatorConfigError, ErrorCode, KvsServiceError } from './errors.js';
export {
  SCHEMA_LIMITS,
  buildSchema,
  entitiesFromManifest,
  loadManifestEntities,
  type AttributeType,
  type EntityDefinition,
  type ManifestIndex
} from './schema.js';
export { DEFAULT_LIMITS, type Limits } from './validation.js';
