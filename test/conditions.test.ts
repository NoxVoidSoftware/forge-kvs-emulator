/**
 * Every condition operator, in the wire format @forge/kvs sends.
 */

import { describe, expect, it } from 'vitest';
import { compareValues, matchesCondition, matchesFilters } from '../src/conditions.js';
import { KvsServiceError } from '../src/errors.js';

const c = (condition: string, ...values: unknown[]) => ({ condition, values });

describe('matchesCondition', () => {
  const table: Array<[string, unknown[], unknown, boolean]> = [
    ['EXISTS', [true], 'x', true],
    ['EXISTS', [true], undefined, false],
    ['NOT_EXISTS', [true], undefined, true],
    ['NOT_EXISTS', [true], 0, false],
    ['EQUAL_TO', ['a'], 'a', true],
    ['EQUAL_TO', [false], false, true],
    ['EQUAL_TO', ['a'], undefined, false],
    ['NOT_EQUAL_TO', ['a'], 'b', true],
    ['NOT_EQUAL_TO', ['a'], undefined, true],
    ['NOT_EQUAL_TO', ['a'], 'a', false],
    ['BEGINS_WITH', ['ab'], 'abc', true],
    ['BEGINS_WITH', ['ab'], 'xab', false],
    ['BEGINS_WITH', ['ab'], undefined, false],
    ['BETWEEN', [2, 10], 10, true],
    ['BETWEEN', [2, 10], 11, false],
    ['BETWEEN', ['b', 'd'], 'c', true],
    ['BETWEEN', [2, 10], undefined, false],
    ['GREATER_THAN', [9], 10, true],
    ['GREATER_THAN', [10], 10, false],
    ['GREATER_THAN', [10], undefined, false],
    ['GREATER_THAN_EQUAL_TO', [10], 10, true],
    ['GREATER_THAN_EQUAL_TO', [10], undefined, false],
    ['LESS_THAN', [10], 9, true],
    ['LESS_THAN', [10], 10, false],
    ['LESS_THAN', [10], undefined, false],
    ['LESS_THAN_EQUAL_TO', [10], 10, true],
    ['LESS_THAN_EQUAL_TO', [10], undefined, false],
    ['CONTAINS', ['ell'], 'hello', true],
    ['CONTAINS', ['x'], ['x', 'y'], true],
    ['CONTAINS', ['z'], ['x', 'y'], false],
    ['CONTAINS', ['x'], 5, false],
    ['CONTAINS', ['x'], undefined, false],
    ['NOT_CONTAINS', ['z'], 'hello', true],
    ['NOT_CONTAINS', ['ell'], 'hello', false],
    ['NOT_CONTAINS', ['z'], undefined, false]
  ];
  for (const [condition, values, actual, expected] of table) {
    it(`${condition}(${JSON.stringify(values)}) on ${JSON.stringify(actual)} is ${expected}`, () => {
      expect(matchesCondition(c(condition, ...values), actual)).toBe(expected);
    });
  }

  it('refuses unknown conditions', () => {
    expect(() => matchesCondition(c('LIKE', 'a'), 'a')).toThrow(KvsServiceError);
  });

  it('compares numbers numerically and everything else as text', () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues('2', '10')).toBeGreaterThan(0);
    expect(compareValues('a', 'a')).toBe(0);
  });
});

describe('matchesFilters', () => {
  const record = { status: 'open', total: 5 };
  const eq = (property: string, value: unknown) => ({ property, condition: 'EQUAL_TO', values: [value] });

  it('combines with and / or', () => {
    expect(matchesFilters({ and: [eq('status', 'open'), eq('total', 5)] }, record)).toBe(true);
    expect(matchesFilters({ and: [eq('status', 'open'), eq('total', 6)] }, record)).toBe(false);
    expect(matchesFilters({ or: [eq('status', 'paid'), eq('total', 5)] }, record)).toBe(true);
    expect(matchesFilters({ or: [eq('status', 'paid'), eq('total', 6)] }, record)).toBe(false);
  });

  it('passes without filters and treats a missing record as empty', () => {
    expect(matchesFilters(undefined, record)).toBe(true);
    expect(matchesFilters({}, record)).toBe(true);
    expect(matchesFilters({ and: [{ property: 'rev', condition: 'NOT_EXISTS', values: [true] }] }, undefined)).toBe(
      true
    );
  });

  it('refuses malformed filters', () => {
    expect(() => matchesFilters({ and: [eq('a', 1)], or: [eq('b', 2)] }, record)).toThrow(KvsServiceError);
    expect(() => matchesFilters({ and: [{ condition: 'EXISTS', values: [true] }] }, record)).toThrow(KvsServiceError);
  });
});
