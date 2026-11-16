/**
 * In-memory emulation of the Forge KVS / Custom Entity Store REST API.
 *
 * `@forge/kvs` sends every operation as `POST /api/v1/<operation>` through
 * `globalThis.__forge_fetch__`. The emulator answers those requests, so the
 * real client library (query builders, filters, transactions, error mapping)
 * runs unmodified in tests.
 */

import { ErrorCode, KvsServiceError, badRequest } from './errors.js';
import {
  RANGE_CONDITIONS,
  compareValues,
  matchesCondition,
  matchesFilters,
  type WireCondition,
  type WireFilters
} from './conditions.js';
import {
  buildSchema,
  loadManifestEntities,
  type EntityDefinition,
  type EntitySchema,
  type IndexDefinition,
  type Schema
} from './schema.js';
import { DEFAULT_LIMITS, validateEntityValue, validateKey, validateValue, type Limits } from './validation.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KvsEmulatorOptions {
  /** Path to manifest.yml; its `app.storage.entities` define the Custom Entities. */
  manifestPath?: string;
  /** Entity definitions in manifest format (instead of, or in addition to, `manifestPath`). */
  entities?: EntityDefinition[];
  /**
   * Accept entity attributes that are not declared in the manifest.
   * Default `false`: undeclared attributes are refused, which catches
   * manifest drift early.
   */
  allowUnknownAttributes?: boolean;
  /**
   * Simulated latency of every request:
   * - `'tick'` (default): resolve on the next macrotask, so concurrent callers
   *   interleave the way they do against a real service;
   * - a number: milliseconds;
   * - `0`: resolve on the microtask queue.
   */
  latency?: 'tick' | number;
  /** Clock used for metadata and TTL, in epoch milliseconds. Defaults to `Date.now()` plus `advanceTime()` offsets. */
  now?: () => number;
  /** Override limits (key length, value size, page size, batch size...). */
  limits?: Partial<Limits>;
  /** Keep a log of requests in `emulator.requests` (default `true`). */
  recordRequests?: boolean;
}

/** One handled request, for assertions. */
export interface RecordedRequest {
  /** Operation name, e.g. `entity.set`, `query`, `transaction`. */
  operation: string;
  /** Parsed request body as sent by `@forge/kvs`. */
  body: unknown;
  /** HTTP status the emulator answered with. */
  status: number;
  /** Error code for failed requests. */
  code?: string;
}

/** Fault to inject with `failNext`. */
export interface InjectedFault {
  status?: number;
  code: string;
  message?: string;
}

export type OperationMatcher = string | ((operation: string, body: unknown) => boolean);

export interface StoredRecord<T = unknown> {
  key: string;
  value: T;
  createdAt: number;
  updatedAt: number;
  /** Epoch milliseconds, when a TTL was set. */
  expiresAt?: number;
}

/** Opaque copy of the whole store, see `snapshot()` / `restore()`. */
export interface EmulatorSnapshot {
  readonly plain: ReadonlyArray<[string, StoredRecord]>;
  readonly secrets: ReadonlyArray<[string, StoredRecord]>;
  readonly entities: ReadonlyArray<[string, ReadonlyArray<[string, StoredRecord]>]>;
}

/** Minimal `fetch`-like signature `@forge/kvs` uses. */
export type FetchLike = (
  path: string,
  init?: { method?: string; body?: unknown; headers?: unknown }
) => Promise<Response>;

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Table = Map<string, StoredRecord>;

interface SetOptionsWire {
  ttl?: { value: number; unit: string };
  keyPolicy?: 'OVERRIDE' | 'FAIL_IF_EXISTS';
  returnValue?: 'PREVIOUS' | 'LATEST';
  returnMetadataFields?: string[];
}

const TTL_UNITS: Record<string, number> = { SECONDS: 1000, MINUTES: 60_000, HOURS: 3_600_000, DAYS: 86_400_000 };
const BY_KEY_INDEX = 'by-key';

const clone = <T>(value: T): T => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T));

const encodeCursor = (offset: number): string =>
  Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');

function decodeCursor(cursor: unknown): number {
  if (cursor === undefined || cursor === null || cursor === '') return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8')) as { o?: unknown };
    if (Number.isInteger(parsed.o) && (parsed.o as number) >= 0) return parsed.o as number;
  } catch {
    // fall through
  }
  throw badRequest(ErrorCode.INVALID_CURSOR, 'The cursor is not valid.');
}

function operationOf(path: string): string {
  const match = /^\/api\/v1\/(.+)$/.exec(path.split('?')[0] ?? '');
  return match ? match[1]!.replace(/\//g, '.') : path;
}

// ---------------------------------------------------------------------------
// Emulator
// ---------------------------------------------------------------------------

export class KvsEmulator {
  /** Requests handled so far (when `recordRequests` is on). */
  readonly requests: RecordedRequest[] = [];

  private readonly schema: Schema;
  private readonly limits: Limits;
  private readonly allowUnknownAttributes: boolean;
  private readonly latency: 'tick' | number;
  private readonly clock: () => number;
  private readonly recordRequests: boolean;
  private timeOffset = 0;

  private plain: Table = new Map();
  private secrets: Table = new Map();
  private entities = new Map<string, Table>();
  private faults: Array<{ matcher: OperationMatcher; fault: InjectedFault; remaining: number }> = [];

  constructor(options: KvsEmulatorOptions = {}) {
    const definitions = [
      ...(options.manifestPath ? loadManifestEntities(options.manifestPath) : []),
      ...(options.entities ?? [])
    ];
    this.schema = buildSchema(definitions);
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.allowUnknownAttributes = options.allowUnknownAttributes === true;
    this.latency = options.latency ?? 'tick';
    this.clock = options.now ?? (() => Date.now() + this.timeOffset);
    this.recordRequests = options.recordRequests !== false;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  /**
   * Handles one request the way the Forge storage service would. Pass this
   * as the fetch client, or install it with `installKvsEmulator`.
   */
  readonly fetch: FetchLike = async (path, init) => {
    await this.wait();
    const operation = operationOf(path);
    let body: unknown;
    try {
      body = init?.body === undefined || init.body === '' ? {} : JSON.parse(String(init.body));
    } catch {
      return this.respond(
        operation,
        undefined,
        badRequest(ErrorCode.INVALID_REQUEST, 'The request body is not valid JSON.')
      );
    }

    const fault = this.takeFault(operation, body);
    if (fault) {
      return this.respond(
        operation,
        body,
        new KvsServiceError(fault.status ?? 500, fault.code, fault.message ?? `Injected fault: ${fault.code}`)
      );
    }

    try {
      const result = this.dispatch(operation, body as Record<string, unknown>);
      return this.respond(operation, body, undefined, result);
    } catch (error) {
      if (error instanceof KvsServiceError) return this.respond(operation, body, error);
      throw error;
    }
  };

  private async wait(): Promise<void> {
    if (this.latency === 'tick') await new Promise<void>((resolve) => setImmediate(resolve));
    else if (typeof this.latency === 'number' && this.latency > 0)
      await new Promise<void>((resolve) => setTimeout(resolve, this.latency as number));
    else await Promise.resolve();
  }

  private respond(operation: string, body: unknown, error?: KvsServiceError, result?: unknown): Response {
    if (error) {
      if (this.recordRequests)
        this.requests.push({ operation, body: clone(body), status: error.status, code: error.code });
      return new Response(JSON.stringify(error.toBody()), {
        status: error.status,
        headers: { 'content-type': 'application/json', 'x-trace-id': 'kvs-emulator' }
      });
    }
    if (result === undefined) {
      if (this.recordRequests) this.requests.push({ operation, body: clone(body), status: 204 });
      return new Response(null, { status: 204 });
    }
    if (this.recordRequests) this.requests.push({ operation, body: clone(body), status: 200 });
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  }

  private dispatch(operation: string, body: Record<string, unknown>): unknown {
    switch (operation) {
      case 'get':
        return this.read(this.plain, body);
      case 'set':
        return this.write(this.plain, body, undefined);
      case 'delete':
        return this.remove(this.plain, body);
      case 'query':
        return this.queryPlain(body);
      case 'secret.get':
        return this.read(this.secrets, body);
      case 'secret.set':
        return this.write(this.secrets, body, undefined);
      case 'secret.delete':
        return this.remove(this.secrets, body);
      case 'entity.get': {
        const schema = this.entitySchema(body.entityName);
        return this.read(this.table(schema.name), body);
      }
      case 'entity.set': {
        const schema = this.entitySchema(body.entityName);
        return this.write(this.table(schema.name), body, schema);
      }
      case 'entity.delete': {
        const schema = this.entitySchema(body.entityName);
        return this.remove(this.table(schema.name), body);
      }
      case 'entity.query':
        return this.queryEntity(body);
      case 'batch.set':
        return this.batchSet(body as unknown as unknown[]);
      case 'batch.get':
        return this.batchGet(body as unknown as unknown[]);
      case 'batch.delete':
        return this.batchDelete(body as unknown as unknown[]);
      case 'transaction':
        return this.transact(body);
      default:
        throw new KvsServiceError(404, ErrorCode.NOT_IMPLEMENTED, `The emulator does not implement "${operation}".`);
    }
  }

  // -------------------------------------------------------------------------
  // Single-key operations
  // -------------------------------------------------------------------------

  private now(): number {
    return this.clock();
  }

  private live(table: Table, key: string): StoredRecord | undefined {
    const record = table.get(key);
    if (record && record.expiresAt !== undefined && record.expiresAt <= this.now()) {
      table.delete(key);
      return undefined;
    }
    return record;
  }

  private wire(record: StoredRecord, metadataFields?: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = { key: record.key, value: clone(record.value) };
    const fields = Array.isArray(metadataFields) ? metadataFields : ['CREATED_AT', 'UPDATED_AT', 'EXPIRE_TIME'];
    if (fields.includes('CREATED_AT')) out.createdAt = record.createdAt;
    if (fields.includes('UPDATED_AT')) out.updatedAt = record.updatedAt;
    if (fields.includes('EXPIRE_TIME') && record.expiresAt !== undefined)
      out.expireTime = new Date(record.expiresAt).toISOString();
    return out;
  }

  private read(table: Table, body: Record<string, unknown>): unknown {
    validateKey(body.key, this.limits);
    const record = this.live(table, body.key);
    if (!record) throw new KvsServiceError(404, ErrorCode.KEY_NOT_FOUND, `Key "${body.key}" was not found.`);
    return this.wire(record);
  }

  private prepareWrite(table: Table, body: Record<string, unknown>, schema: EntitySchema | undefined) {
    validateKey(body.key, this.limits);
    if (!('value' in body)) throw badRequest(ErrorCode.INVALID_VALUE, 'A value is required.');
    if (schema)
      validateEntityValue(schema, body.value, this.limits, { allowUnknownAttributes: this.allowUnknownAttributes });
    else validateValue(body.value, this.limits);

    const options = (body.options ?? {}) as SetOptionsWire;
    const previous = this.live(table, body.key);
    if (options.keyPolicy === 'FAIL_IF_EXISTS' && previous) {
      throw new KvsServiceError(409, ErrorCode.KEY_ALREADY_EXISTS, `Key "${body.key}" already exists.`);
    }
    let expiresAt: number | undefined;
    if (options.ttl) {
      const factor = TTL_UNITS[options.ttl.unit];
      if (!factor || !(options.ttl.value > 0)) throw badRequest(ErrorCode.INVALID_REQUEST, 'The TTL is not valid.');
      expiresAt = this.now() + options.ttl.value * factor;
    }
    const now = this.now();
    const next: StoredRecord = {
      key: body.key,
      value: clone(body.value),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      ...(expiresAt !== undefined ? { expiresAt } : {})
    };
    return { key: body.key, next, previous, options };
  }

  private write(table: Table, body: Record<string, unknown>, schema: EntitySchema | undefined): unknown {
    const { key, next, previous, options } = this.prepareWrite(table, body, schema);
    table.set(key, next);
    if (options.returnValue === 'PREVIOUS')
      return previous ? this.wire(previous, options.returnMetadataFields) : undefined;
    if (options.returnValue === 'LATEST') return this.wire(next, options.returnMetadataFields);
    return undefined;
  }

  private remove(table: Table, body: Record<string, unknown>): undefined {
    validateKey(body.key, this.limits);
    table.delete(body.key);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  private pageSize(limit: unknown): number {
    if (limit === undefined || limit === null) return this.limits.defaultQueryLimit;
    if (!Number.isInteger(limit) || (limit as number) < 1)
      throw badRequest(ErrorCode.INVALID_REQUEST, 'The limit must be a positive integer.');
    return Math.min(limit as number, this.limits.maxQueryLimit);
  }

  private page(rows: StoredRecord[], body: Record<string, unknown>, cursorField: 'after' | 'cursor') {
    const offset = decodeCursor(body[cursorField]);
    const size = this.pageSize(body.limit);
    const slice = rows.slice(offset, offset + size);
    const metadataFields =
      (body.options as { metadataFields?: unknown } | undefined)?.metadataFields ?? body.metadataFields;
    const data = slice.map((record) => {
      const out = this.wire(record, Array.isArray(metadataFields) ? metadataFields : []);
      if (record.expiresAt !== undefined) out.expireTime = new Date(record.expiresAt).toISOString();
      return out;
    });
    const next = offset + size;
    return next < rows.length ? { data, cursor: encodeCursor(next) } : { data };
  }

  private queryPlain(body: Record<string, unknown>) {
    const where = (body.where as WireCondition[] | undefined) ?? [];
    for (const clause of where) {
      if (clause.property !== 'key' || clause.condition !== 'BEGINS_WITH') {
        throw badRequest(ErrorCode.INVALID_REQUEST, 'Key-value queries support only where key BEGINS_WITH.');
      }
    }
    const rows = [...this.plain.keys()]
      .map((key) => this.live(this.plain, key))
      .filter((record): record is StoredRecord => record !== undefined)
      .filter((record) => where.every((clause) => matchesCondition(clause, record.key)))
      .sort((a, b) => compareValues(a.key, b.key));
    return this.page(rows, body, 'after');
  }

  private indexOf(schema: EntitySchema, indexName: unknown): IndexDefinition {
    if (indexName === BY_KEY_INDEX) return { name: BY_KEY_INDEX, partition: [], range: undefined };
    const index = typeof indexName === 'string' ? schema.indexes.get(indexName) : undefined;
    if (!index) {
      throw badRequest(
        ErrorCode.INVALID_INDEX,
        `Index "${String(indexName)}" is not declared for entity "${schema.name}".`,
        {
          entityName: schema.name
        }
      );
    }
    return index;
  }

  private queryEntity(body: Record<string, unknown>) {
    const schema = this.entitySchema(body.entityName);
    const index = this.indexOf(schema, body.indexName);
    const partition = (body.partition as unknown[] | undefined) ?? [];
    if (partition.length !== index.partition.length) {
      throw badRequest(
        ErrorCode.INVALID_INDEX,
        `Index "${index.name}" of entity "${schema.name}" expects ${index.partition.length} partition value(s), got ${partition.length}.`
      );
    }
    const range = body.range as WireCondition | undefined;
    if (range) {
      if (!RANGE_CONDITIONS.has(range.condition)) {
        throw badRequest(ErrorCode.INVALID_REQUEST, `"${range.condition}" cannot be used in where().`);
      }
      if (!index.range && index.name !== BY_KEY_INDEX) {
        throw badRequest(
          ErrorCode.INVALID_REQUEST,
          `Index "${index.name}" has no range attribute to filter with where().`
        );
      }
    }
    const sortValue = (record: StoredRecord) =>
      index.name === BY_KEY_INDEX ? record.key : (record.value as Record<string, unknown>)[index.range as string];

    const table = this.table(schema.name);
    const rows = [...table.keys()]
      .map((key) => this.live(table, key))
      .filter((record): record is StoredRecord => record !== undefined)
      // Sparse index: entities without every index attribute are not in it.
      .filter((record) => {
        const value = record.value as Record<string, unknown>;
        if (index.name !== BY_KEY_INDEX && index.range && value[index.range] === undefined) return false;
        return index.partition.every(
          (attribute, i) => value[attribute] !== undefined && value[attribute] === partition[i]
        );
      })
      .filter((record) => !range || matchesCondition(range, sortValue(record)))
      .filter((record) =>
        matchesFilters(body.filters as WireFilters | undefined, record.value as Record<string, unknown>)
      )
      .sort((a, b) => compareValues(sortValue(a), sortValue(b)) || compareValues(a.key, b.key));
    if (body.sort === 'DESC') rows.reverse();
    return this.page(rows, body, 'cursor');
  }

  // -------------------------------------------------------------------------
  // Batches
  // -------------------------------------------------------------------------

  private batchItems(body: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(body)) throw badRequest(ErrorCode.INVALID_REQUEST, 'A batch request is a list of items.');
    if (body.length > this.limits.maxBatchItems) {
      throw badRequest(ErrorCode.BATCH_TOO_LARGE, `A batch may contain at most ${this.limits.maxBatchItems} items.`);
    }
    return body as Array<Record<string, unknown>>;
  }

  private itemTarget(item: Record<string, unknown>): { table: Table; schema?: EntitySchema } {
    if (item.entityName === undefined) return { table: this.plain };
    const schema = this.entitySchema(item.entityName);
    return { table: this.table(schema.name), schema };
  }

  private failure(item: Record<string, unknown>, error: unknown) {
    if (!(error instanceof KvsServiceError)) throw error;
    return {
      key: String(item.key),
      ...(item.entityName !== undefined ? { entityName: item.entityName } : {}),
      error: { code: error.code, message: error.message }
    };
  }

  private batchSet(body: unknown) {
    const successfulKeys: unknown[] = [];
    const failedKeys: unknown[] = [];
    for (const item of this.batchItems(body)) {
      try {
        const { table, schema } = this.itemTarget(item);
        this.write(table, { key: item.key, value: item.value, options: item.options }, schema);
        successfulKeys.push({
          key: item.key,
          ...(item.entityName !== undefined ? { entityName: item.entityName } : {})
        });
      } catch (error) {
        failedKeys.push(this.failure(item, error));
      }
    }
    return { successfulKeys, failedKeys };
  }

  private batchGet(body: unknown) {
    const successfulKeys: unknown[] = [];
    const failedKeys: unknown[] = [];
    for (const item of this.batchItems(body)) {
      try {
        const { table } = this.itemTarget(item);
        const record = this.read(table, item) as Record<string, unknown>;
        successfulKeys.push({ ...record, ...(item.entityName !== undefined ? { entityName: item.entityName } : {}) });
      } catch (error) {
        failedKeys.push(this.failure(item, error));
      }
    }
    return { successfulKeys, failedKeys };
  }

  private batchDelete(body: unknown) {
    const successfulKeys: unknown[] = [];
    const failedKeys: unknown[] = [];
    for (const item of this.batchItems(body)) {
      try {
        const { table } = this.itemTarget(item);
        this.remove(table, item);
        successfulKeys.push({
          key: item.key,
          ...(item.entityName !== undefined ? { entityName: item.entityName } : {})
        });
      } catch (error) {
        failedKeys.push(this.failure(item, error));
      }
    }
    return { successfulKeys, failedKeys };
  }

  // -------------------------------------------------------------------------
  // Transactions: all conditions are checked first, then everything is applied.
  // -------------------------------------------------------------------------

  private transact(body: Record<string, unknown>): undefined {
    const sets = (body.set as Array<Record<string, unknown>> | undefined) ?? [];
    const deletes = (body.delete as Array<Record<string, unknown>> | undefined) ?? [];
    const checks = (body.check as Array<Record<string, unknown>> | undefined) ?? [];
    const total = sets.length + deletes.length + checks.length;
    if (total === 0) throw badRequest(ErrorCode.INVALID_TRANSACTION, 'A transaction needs at least one operation.');
    if (total > this.limits.maxTransactionOperations) {
      throw badRequest(
        ErrorCode.INVALID_TRANSACTION,
        `A transaction may contain at most ${this.limits.maxTransactionOperations} operations.`
      );
    }

    const seen = new Set<string>();
    const identity = (item: Record<string, unknown>) => `${String(item.entityName ?? '')}\u0000${String(item.key)}`;
    for (const item of [...sets, ...deletes, ...checks]) {
      validateKey(item.key, this.limits);
      const id = identity(item);
      if (seen.has(id)) {
        throw badRequest(
          ErrorCode.INVALID_TRANSACTION,
          `Key "${String(item.key)}" appears more than once in the transaction.`
        );
      }
      seen.add(id);
    }
    for (const check of checks) {
      if (!check.conditions) throw badRequest(ErrorCode.INVALID_TRANSACTION, 'A check needs conditions.');
    }

    // Validate writes and evaluate every condition before touching anything.
    const plannedSets = sets.map((item) => {
      const { table, schema } = this.itemTarget(item);
      const planned = this.prepareWrite(table, { key: item.key, value: item.value, options: item.options }, schema);
      return { table, item, planned };
    });
    for (const item of [...sets, ...deletes, ...checks]) {
      const { table } = this.itemTarget(item);
      const current = this.live(table, String(item.key));
      const conditions = item.conditions as WireFilters | undefined;
      if (conditions && !matchesFilters(conditions, current?.value as Record<string, unknown> | undefined)) {
        throw new KvsServiceError(
          409,
          ErrorCode.CONDITION_CHECK_FAILED,
          `A condition on key "${String(item.key)}" did not hold; nothing was written.`,
          {
            key: item.key,
            ...(item.entityName !== undefined ? { entityName: item.entityName } : {})
          }
        );
      }
    }

    for (const { table, planned } of plannedSets) table.set(planned.key, planned.next);
    for (const item of deletes) this.itemTarget(item).table.delete(String(item.key));
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Schema helpers
  // -------------------------------------------------------------------------

  private entitySchema(entityName: unknown): EntitySchema {
    if (typeof entityName !== 'string' || entityName.length === 0) {
      throw badRequest(ErrorCode.INVALID_ENTITY_TYPE, 'An entity name is required.');
    }
    const schema = this.schema.get(entityName);
    if (!schema) {
      throw badRequest(ErrorCode.ENTITY_NOT_FOUND, `Entity "${entityName}" is not declared in the manifest.`, {
        entityName
      });
    }
    return schema;
  }

  private table(entityName: string): Table {
    let table = this.entities.get(entityName);
    if (!table) {
      table = new Map();
      this.entities.set(entityName, table);
    }
    return table;
  }

  // -------------------------------------------------------------------------
  // Test API: direct, synchronous access to the stored data
  // -------------------------------------------------------------------------

  /** Declared entity names. */
  get entityNames(): string[] {
    return [...this.schema.keys()];
  }

  /** Value stored under a key-value key, or `undefined`. */
  getValue<T = unknown>(key: string): T | undefined {
    return clone(this.live(this.plain, key)?.value as T | undefined);
  }

  /** Secret stored under a key, or `undefined`. */
  getSecret<T = unknown>(key: string): T | undefined {
    return clone(this.live(this.secrets, key)?.value as T | undefined);
  }

  /** One entity value, or `undefined`. */
  getEntity<T = unknown>(entityName: string, key: string): T | undefined {
    const schema = this.entitySchema(entityName);
    return clone(this.live(this.table(schema.name), key)?.value as T | undefined);
  }

  /** Every stored entity of one type, ordered by key. */
  listEntities<T = unknown>(entityName: string): Array<{ key: string; value: T }> {
    const schema = this.entitySchema(entityName);
    const table = this.table(schema.name);
    return [...table.keys()]
      .sort()
      .map((key) => this.live(table, key))
      .filter((record): record is StoredRecord => record !== undefined)
      .map((record) => ({ key: record.key, value: clone(record.value as T) }));
  }

  /** Every key-value key, ordered. */
  listKeys(): string[] {
    return [...this.plain.keys()].filter((key) => this.live(this.plain, key)).sort();
  }

  /** Seeds a key-value entry (validated like a real write). */
  seedValue(key: string, value: unknown): void {
    this.write(this.plain, { key, value }, undefined);
  }

  /** Seeds a secret (validated like a real write). */
  seedSecret(key: string, value: unknown): void {
    this.write(this.secrets, { key, value }, undefined);
  }

  /** Seeds an entity (validated against the manifest schema). */
  seedEntity(entityName: string, key: string, value: unknown): void {
    const schema = this.entitySchema(entityName);
    this.write(this.table(schema.name), { key, value }, schema);
  }

  /**
   * Makes the next matching request(s) fail. `matcher` is an operation name
   * (`'entity.set'`, `'transaction'`, `'get'`...) or a predicate.
   */
  failNext(matcher: OperationMatcher, fault: InjectedFault, options: { times?: number } = {}): void {
    this.faults.push({ matcher, fault, remaining: options.times ?? 1 });
  }

  private takeFault(operation: string, body: unknown): InjectedFault | undefined {
    const index = this.faults.findIndex(({ matcher }) =>
      typeof matcher === 'string' ? matcher === operation : matcher(operation, body)
    );
    if (index < 0) return undefined;
    const entry = this.faults[index]!;
    entry.remaining -= 1;
    if (entry.remaining <= 0) this.faults.splice(index, 1);
    return entry.fault;
  }

  /** Moves the emulator's clock forward (TTL, metadata). Ignored when a custom `now` is set. */
  advanceTime(milliseconds: number): void {
    this.timeOffset += milliseconds;
  }

  /** Copy of the whole store. */
  snapshot(): EmulatorSnapshot {
    const copy = (table: Table): Array<[string, StoredRecord]> =>
      [...table.entries()].map(([key, record]) => [key, clone(record)]);
    return {
      plain: copy(this.plain),
      secrets: copy(this.secrets),
      entities: [...this.entities.entries()].map(([name, table]) => [name, copy(table)])
    };
  }

  /** Puts the store back to a snapshot. */
  restore(snapshot: EmulatorSnapshot): void {
    const table = (rows: ReadonlyArray<[string, StoredRecord]>): Table =>
      new Map(rows.map(([key, record]) => [key, clone(record)]));
    this.plain = table(snapshot.plain);
    this.secrets = table(snapshot.secrets);
    this.entities = new Map(snapshot.entities.map(([name, rows]) => [name, table(rows)]));
  }

  /** Empties the store, the request log and pending faults. Keeps the schema. */
  reset(): void {
    this.plain = new Map();
    this.secrets = new Map();
    this.entities = new Map();
    this.faults = [];
    this.requests.length = 0;
    this.timeOffset = 0;
  }
}

/** Creates an emulator. Shorthand for `new KvsEmulator(options)`. */
export function createKvsEmulator(options: KvsEmulatorOptions = {}): KvsEmulator {
  return new KvsEmulator(options);
}
