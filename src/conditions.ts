/**
 * Evaluation of query `where` clauses, entity filters and transaction
 * conditions, in the wire format `@forge/kvs` sends:
 *
 *   { condition: 'BETWEEN', values: [a, b], property?: 'status' }
 */

import { ErrorCode, badRequest } from './errors.js';

export interface WireCondition {
  condition: string;
  values?: unknown[];
  property?: string;
}

export interface WireFilters {
  and?: WireCondition[];
  or?: WireCondition[];
}

type Comparable = string | number | boolean;

/** Orders values like the storage service: numbers numerically, everything else as strings. */
export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const left = String(a);
  const right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Whether `actual` (undefined when the attribute is missing) satisfies the clause. */
export function matchesCondition(clause: WireCondition, actual: unknown): boolean {
  const [first, second] = (clause.values ?? []) as Comparable[];
  const present = actual !== undefined;
  switch (clause.condition) {
    case 'EXISTS':
      return present;
    case 'NOT_EXISTS':
      return !present;
    case 'EQUAL_TO':
      return present && actual === first;
    case 'NOT_EQUAL_TO':
      return actual !== first;
    case 'BEGINS_WITH':
      return present && String(actual).startsWith(String(first));
    case 'BETWEEN':
      return present && compareValues(actual, first) >= 0 && compareValues(actual, second) <= 0;
    case 'GREATER_THAN':
      return present && compareValues(actual, first) > 0;
    case 'GREATER_THAN_EQUAL_TO':
      return present && compareValues(actual, first) >= 0;
    case 'LESS_THAN':
      return present && compareValues(actual, first) < 0;
    case 'LESS_THAN_EQUAL_TO':
      return present && compareValues(actual, first) <= 0;
    case 'CONTAINS':
      return containsValue(actual, first);
    case 'NOT_CONTAINS':
      return present && !containsValue(actual, first);
    default:
      throw badRequest(ErrorCode.INVALID_REQUEST, `Unsupported condition "${clause.condition}".`);
  }
}

function containsValue(actual: unknown, needle: unknown): boolean {
  if (typeof actual === 'string') return actual.includes(String(needle));
  if (Array.isArray(actual)) return actual.includes(needle);
  return false;
}

/** Conditions allowed in `where` (range) clauses of entity queries. */
export const RANGE_CONDITIONS = new Set([
  'BEGINS_WITH',
  'BETWEEN',
  'EQUAL_TO',
  'GREATER_THAN',
  'GREATER_THAN_EQUAL_TO',
  'LESS_THAN',
  'LESS_THAN_EQUAL_TO'
]);

/**
 * Evaluates `{ and: [...] }` or `{ or: [...] }` against a record. A missing
 * record is treated as one without attributes, so `NOT_EXISTS` holds for it.
 */
export function matchesFilters(filters: WireFilters | undefined, record: Record<string, unknown> | undefined): boolean {
  if (!filters) return true;
  const target = record ?? {};
  const check = (clause: WireCondition) => {
    if (typeof clause.property !== 'string') {
      throw badRequest(ErrorCode.INVALID_REQUEST, 'A filter condition needs a property.');
    }
    return matchesCondition(clause, target[clause.property]);
  };
  if (filters.and && filters.or) {
    throw badRequest(ErrorCode.INVALID_REQUEST, 'Filters combine either with and or with or, not both.');
  }
  if (filters.and) return filters.and.every(check);
  if (filters.or) return filters.or.some(check);
  return true;
}
