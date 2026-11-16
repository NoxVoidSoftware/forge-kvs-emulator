/**
 * Custom Entities: schema enforcement and index queries, through the real
 * @forge/kvs client.
 */

import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Filter, FilterConditions, ForgeKvsAPIError, Sort, WhereConditions, kvs } from '@forge/kvs';
import { useKvsEmulator } from '../src/index.js';

const manifestPath = fileURLToPath(new URL('./fixtures/manifest.yml', import.meta.url));
const emulator = useKvsEmulator({ manifestPath }, { beforeEach, afterAll });

interface Order {
  customerId: string;
  status: string;
  createdAt: string;
  total?: number;
  quantity?: number;
  paid?: boolean;
  tags?: unknown;
  note?: string;
  rev?: number;
}

const orders = () => kvs.entity<Order>('order');

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeKvsAPIError);
    return (error as ForgeKvsAPIError).code;
  }
}

async function seedOrders() {
  const rows: Array<[string, Order]> = [
    ['o1', { customerId: 'c1', status: 'open', createdAt: '2026-01-01', total: 10 }],
    ['o2', { customerId: 'c1', status: 'paid', createdAt: '2026-01-03', total: 30, paid: true }],
    ['o3', { customerId: 'c1', status: 'open', createdAt: '2026-01-02', total: 20 }],
    ['o4', { customerId: 'c2', status: 'open', createdAt: '2026-01-01', total: 5 }]
  ];
  for (const [key, value] of rows) await orders().set(key, value);
}

describe('schema enforcement', () => {
  it('stores and reads a valid entity', async () => {
    const order = {
      customerId: 'c1',
      status: 'open',
      createdAt: '2026-01-01',
      total: 9.99,
      quantity: 3,
      paid: false,
      tags: ['a', { b: 1 }]
    };
    await orders().set('o1', order);
    expect(await orders().get('o1')).toEqual(order);
    expect(emulator.getEntity('order', 'o1')).toEqual(order);
  });

  it('refuses empty and blank strings, like Forge', async () => {
    expect(await codeOf(orders().set('o1', { customerId: 'c1', status: 'open', createdAt: '2026', note: '' }))).toBe(
      'EMPTY_PROPERTY_VALUE'
    );
    expect(await codeOf(orders().set('o1', { customerId: 'c1', status: 'open', createdAt: '2026', note: '   ' }))).toBe(
      'EMPTY_PROPERTY_VALUE'
    );
  });

  it('enforces attribute types and ranges', async () => {
    const base = { customerId: 'c1', status: 'open', createdAt: '2026' };
    const cases: Array<Record<string, unknown>> = [
      { quantity: 1.5 },
      { quantity: 2 ** 31 },
      { quantity: '3' },
      { total: 'ten' },
      { total: 1e-200 },
      { paid: 'yes' },
      { status: 7 },
      { note: null }
    ];
    for (const patch of cases) {
      expect(await codeOf(orders().set('o1', { ...base, ...patch } as unknown as Order)), JSON.stringify(patch)).toBe(
        'INVALID_ENTITY_VALUE'
      );
    }
    await orders().set('o1', { ...base, quantity: -(2 ** 31), total: 0 });
  });

  it('refuses entities and attributes the manifest does not declare', async () => {
    expect(await codeOf(kvs.entity('invoice').set('i1', { a: 'b' }))).toBe('ENTITY_NOT_FOUND');
    expect(
      await codeOf(orders().set('o1', { customerId: 'c1', status: 'open', createdAt: '2026', extra: 1 } as Order))
    ).toBe('UNKNOWN_ENTITY_ATTRIBUTE');
  });

  it('refuses index values over the size limit', async () => {
    expect(await codeOf(orders().set('o1', { customerId: 'c'.repeat(1800), status: 'open', createdAt: '2026' }))).toBe(
      'INDEX_VALUE_TOO_LARGE'
    );
  });
});

describe('index queries', () => {
  beforeEach(seedOrders);

  it('reads a partition sorted by the range attribute', async () => {
    const { results } = await orders()
      .query()
      .index('by-customer', { partition: ['c1'] })
      .getMany();
    expect(results.map((r) => r.key)).toEqual(['o1', 'o3', 'o2']);
  });

  it('sorts descending', async () => {
    const { results } = await orders()
      .query()
      .index('by-customer', { partition: ['c1'] })
      .sort(Sort.DESC)
      .getMany();
    expect(results.map((r) => r.key)).toEqual(['o2', 'o3', 'o1']);
  });

  it('filters the range with where()', async () => {
    const between = await orders()
      .query()
      .index('by-customer', { partition: ['c1'] })
      .where(WhereConditions.between('2026-01-02', '2026-01-03'))
      .getMany();
    expect(between.results.map((r) => r.key)).toEqual(['o3', 'o2']);
    const after = await orders()
      .query()
      .index('by-customer', { partition: ['c1'] })
      .where(WhereConditions.greaterThan('2026-01-02'))
      .getMany();
    expect(after.results.map((r) => r.key)).toEqual(['o2']);
  });

  it('uses composite partitions', async () => {
    const { results } = await orders()
      .query()
      .index('by-customer-status', { partition: ['c1', 'open'] })
      .getMany();
    expect(results.map((r) => r.key)).toEqual(['o1', 'o3']);
  });

  it('supports simple indexes declared by attribute name', async () => {
    const { results } = await orders().query().index('status').where(WhereConditions.equalTo('paid')).getMany();
    expect(results.map((r) => r.key)).toEqual(['o2']);
  });

  it('applies and / or filters', async () => {
    const and = await orders()
      .query()
      .index('by-customer', { partition: ['c1'] })
      .filters(
        new Filter<Order>()
          .and('status', FilterConditions.equalTo('open'))
          .and('total', FilterConditions.greaterThan(15))
      )
      .getMany();
    expect(and.results.map((r) => r.key)).toEqual(['o3']);
    const or = await orders()
      .query()
      .index('by-customer', { partition: ['c1'] })
      .filters(
        new Filter<Order>().or('paid', FilterConditions.equalTo(true)).or('total', FilterConditions.lessThan(15))
      )
      .getMany();
    expect(or.results.map((r) => r.key)).toEqual(['o1', 'o2']);
    const missing = await orders()
      .query()
      .index('by-customer', { partition: ['c1'] })
      .filters(new Filter<Order>().and('paid', FilterConditions.notExists()))
      .getMany();
    expect(missing.results.map((r) => r.key)).toEqual(['o1', 'o3']);
  });

  it('pages with limit and cursor, and getOne', async () => {
    const first = await orders()
      .query()
      .index('by-customer', { partition: ['c1'] })
      .limit(2)
      .getMany();
    expect(first.results.map((r) => r.key)).toEqual(['o1', 'o3']);
    const rest = await orders()
      .query()
      .index('by-customer', { partition: ['c1'] })
      .limit(2)
      .cursor(first.nextCursor!)
      .getMany();
    expect(rest.results.map((r) => r.key)).toEqual(['o2']);
    expect(rest.nextCursor).toBeUndefined();
    expect(
      (
        await orders()
          .query()
          .index('by-customer', { partition: ['c2'] })
          .getOne()
      )?.key
    ).toBe('o4');
  });

  it('leaves entities without index attributes out of that index (sparse)', async () => {
    await kvs.entity('order').set('o5', { customerId: 'c1', status: 'open' });
    const { results } = await orders()
      .query()
      .index('by-customer', { partition: ['c1'] })
      .getMany();
    expect(results.map((r) => r.key)).not.toContain('o5');
  });

  it('refuses undeclared indexes and wrong partitions', async () => {
    expect(await codeOf(orders().query().index('by-total').getMany())).toBe('INVALID_INDEX');
    expect(await codeOf(orders().query().index('by-customer').getMany())).toBe('INVALID_INDEX');
    expect(
      await codeOf(
        orders()
          .query()
          .index('by-customer', { partition: ['c1', 'x'] })
          .getMany()
      )
    ).toBe('INVALID_INDEX');
  });

  it('clamps the page size to 100', async () => {
    for (let i = 0; i < 120; i += 1) {
      await orders().set(`bulk${String(i).padStart(3, '0')}`, {
        customerId: 'bulk',
        status: 'open',
        createdAt: String(i).padStart(3, '0')
      });
    }
    const page = await orders()
      .query()
      .index('by-customer', { partition: ['bulk'] })
      .limit(500)
      .getMany();
    expect(page.results).toHaveLength(100);
    expect(page.nextCursor).toBeTruthy();
  });
});
