/**
 * Validation of keys and values, following the documented Forge limits.
 */

import { ErrorCode, badRequest } from './errors.js';
import type { EntitySchema } from './schema.js';

export interface Limits {
  /** Maximum key length (Forge: 500). */
  maxKeyLength: number;
  /** Maximum serialised value size in bytes (Forge: 240 KiB). */
  maxValueBytes: number;
  /** Maximum object nesting depth (Forge: 31 per the limits page). */
  maxDepth: number;
  /** Maximum combined size of range values of one index entry (Forge: 900 bytes). */
  maxIndexRangeBytes: number;
  /** Maximum combined size of partition values of one index entry (Forge: 1700 bytes). */
  maxIndexPartitionBytes: number;
  /** Maximum page size of a query; larger limits are clamped. */
  maxQueryLimit: number;
  /** Default page size of a query without `limit`. */
  defaultQueryLimit: number;
  /** Maximum items in one batch request, or `Infinity`. */
  maxBatchItems: number;
  /** Maximum operations in one transaction, or `Infinity`. */
  maxTransactionOperations: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxKeyLength: 500,
  maxValueBytes: 240 * 1024,
  maxDepth: 31,
  maxIndexRangeBytes: 900,
  maxIndexPartitionBytes: 1700,
  maxQueryLimit: 100,
  defaultQueryLimit: 10,
  maxBatchItems: Number.POSITIVE_INFINITY,
  maxTransactionOperations: Number.POSITIVE_INFINITY
};

/** Allowed key pattern from the Forge storage documentation. */
const KEY_PATTERN = /^(?!\s+$)[a-zA-Z0-9:._\s\-#]+$/;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const FLOAT_MIN_MAGNITUDE = 1e-130;
// Forge allows up to 9.99...9E+125 (38 nines), i.e. anything below 1E+126.
const FLOAT_MAX_EXCLUSIVE = 1e126;

export function validateKey(key: unknown, limits: Limits): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) throw badRequest(ErrorCode.EMPTY_KEY, 'The key must not be empty.');
  if (key.length > limits.maxKeyLength) {
    throw badRequest(ErrorCode.KEY_TOO_LONG, `The key is longer than ${limits.maxKeyLength} characters.`);
  }
  if (!KEY_PATTERN.test(key)) {
    throw badRequest(
      ErrorCode.INVALID_KEY,
      `The key "${key}" contains characters that are not allowed (allowed: a-z A-Z 0-9 : . _ - # space).`
    );
  }
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

function depthOf(value: unknown, current = 0): number {
  if (value === null || typeof value !== 'object') return current;
  let deepest = current + 1;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepest = Math.max(deepest, depthOf(child, current + 1));
  }
  return deepest;
}

/** Checks a stored value: a JSON-serialisable string, number, boolean, object or array. */
export function validateValue(value: unknown, limits: Limits): void {
  if (value === undefined || value === null) {
    throw badRequest(ErrorCode.INVALID_VALUE, 'A value is required (null and undefined cannot be stored).');
  }
  const type = typeof value;
  if (!['string', 'number', 'boolean', 'object'].includes(type)) {
    throw badRequest(ErrorCode.INVALID_VALUE, `Values of type ${type} cannot be stored.`);
  }
  if (type === 'number' && !Number.isFinite(value as number)) {
    throw badRequest(ErrorCode.INVALID_VALUE, 'Numbers must be finite.');
  }
  const serialised = JSON.stringify(value);
  if (byteLength(serialised) > limits.maxValueBytes) {
    throw badRequest(ErrorCode.MAX_SIZE, `The value is larger than ${limits.maxValueBytes} bytes.`);
  }
  if (depthOf(value) > limits.maxDepth) {
    throw badRequest(ErrorCode.MAX_DEPTH, `The value is nested deeper than ${limits.maxDepth} levels.`);
  }
}

function attributeError(entity: string, attribute: string, expected: string, value: unknown) {
  return badRequest(
    ErrorCode.INVALID_ENTITY_VALUE,
    `Attribute "${attribute}" of entity "${entity}" must be ${expected}, got ${JSON.stringify(value)}.`,
    { entityName: entity, attribute }
  );
}

function validFloat(value: number): boolean {
  if (value === 0) return true;
  const magnitude = Math.abs(value);
  return magnitude >= FLOAT_MIN_MAGNITUDE && magnitude < FLOAT_MAX_EXCLUSIVE;
}

/**
 * Checks an entity value against its schema: declared attributes, types,
 * ranges, no empty strings, index value sizes.
 */
export function validateEntityValue(
  schema: EntitySchema,
  value: unknown,
  limits: Limits,
  options: { allowUnknownAttributes: boolean }
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(ErrorCode.INVALID_VALUE, `An entity value must be an object (entity "${schema.name}").`);
  }
  validateValue(value, limits);
  const record = value as Record<string, unknown>;

  for (const [attribute, raw] of Object.entries(record)) {
    const type = schema.attributes.get(attribute);
    if (!type) {
      if (options.allowUnknownAttributes) continue;
      throw badRequest(
        ErrorCode.UNKNOWN_ENTITY_ATTRIBUTE,
        `Attribute "${attribute}" is not declared for entity "${schema.name}" in the manifest.`,
        { entityName: schema.name, attribute }
      );
    }
    if (raw === null || raw === undefined) {
      throw attributeError(schema.name, attribute, type, raw);
    }
    if (typeof raw === 'string' && raw.trim() === '' && (type === 'string' || type === 'any')) {
      throw badRequest(ErrorCode.EMPTY_PROPERTY_VALUE, `Value for attribute "${attribute}" cannot be empty.`, {
        entityName: schema.name,
        attribute
      });
    }
    switch (type) {
      case 'string':
        if (typeof raw !== 'string') throw attributeError(schema.name, attribute, 'a string', raw);
        break;
      case 'integer':
        if (!Number.isInteger(raw) || (raw as number) < INT32_MIN || (raw as number) > INT32_MAX) {
          throw attributeError(schema.name, attribute, 'a 32-bit signed integer', raw);
        }
        break;
      case 'float':
        if (typeof raw !== 'number' || !Number.isFinite(raw) || !validFloat(raw)) {
          throw attributeError(schema.name, attribute, 'a float within the supported range', raw);
        }
        break;
      case 'boolean':
        if (typeof raw !== 'boolean') throw attributeError(schema.name, attribute, 'a boolean', raw);
        break;
      default:
        // any: string, number, boolean, object or array; checked by validateValue.
        break;
    }
  }

  for (const index of schema.indexes.values()) {
    const partitionBytes = index.partition.reduce((sum, attribute) => sum + sizeOf(record[attribute]), 0);
    const rangeBytes = index.range ? sizeOf(record[index.range]) : 0;
    if (partitionBytes > limits.maxIndexPartitionBytes || rangeBytes > limits.maxIndexRangeBytes) {
      throw badRequest(
        ErrorCode.INDEX_VALUE_TOO_LARGE,
        `Values of index "${index.name}" of entity "${schema.name}" exceed the size limit ` +
          `(partition ${limits.maxIndexPartitionBytes} B, range ${limits.maxIndexRangeBytes} B).`,
        { entityName: schema.name, index: index.name }
      );
    }
  }
}

function sizeOf(value: unknown): number {
  if (value === undefined) return 0;
  return byteLength(typeof value === 'string' ? value : JSON.stringify(value));
}
