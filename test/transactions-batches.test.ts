/**
 * Transactions and batch operations, through the real @forge/kvs client.
 */

import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Filter, FilterConditions, ForgeKvsAPIError, kvs } from '@forge/kvs';
import { installKvsEmulator, useKvsEmulator } from '../src/index.js';

const manifestPath = fileURLToPath(new URL('./fixtures/manifest.yml', import.meta.url));
const emulator = useKvsEmulator({ manifestPath }, { beforeEach, afterAll });

interface Order {
  customerId: string;
  status: string;
  createdAt: string;
  rev?: number;
}

const order = (rev?: number): Order => ({
  customerId: 'c1',
  status: 'open',
  createdAt: '2026-01-01',
  ...(rev ? { rev } : {})
});

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeKvsAPIError);
    return (error as ForgeKvsAPIError).code;
  }
}

describe('transactions', () => {
  it('writes when conditions hold (optimistic concurrency)', async () => {
    await kvs.entity<Order>('order').set('o1', order(1));
    await kvs
      .transact()
      .set('o1', order(2), {
        entityName: 'order',
        conditions: new Filter<Order>().and('rev', FilterConditions.equalTo(1))
      })
      .execute();
    expect(emulator.getEntity<Order>('order', 'o1')?.rev).toBe(2);
  });

  it('writes nothing when any condition fails', async () => {
    await kvs.entity<Order>('order').set('o1', order(1));
    const code = await codeOf(
      kvs
        .transact()
        .set('o2', order(1), { entityName: 'order' })
        .set('o1', order(3), {
          entityName: 'order',
          conditions: new Filter<Order>().and('rev', FilterConditions.equalTo(2))
        })
        .execute()
    );
    expect(code).toBe('CONDITION_CHECK_FAILED');
    expect(emulator.getEntity('order', 'o2')).toBeUndefined();
    expect(emulator.getEntity<Order>('order', 'o1')?.rev).toBe(1);
  });

  it('treats a missing entity as one without attributes (create-if-absent)', async () => {
    const create = () =>
      kvs
        .transact()
        .set('o1', order(1), {
          entityName: 'order',
          conditions: new Filter<Order>().and('rev', FilterConditions.notExists())
        })
        .execute();
    await create();
    expect(await codeOf(create())).toBe('CONDITION_CHECK_FAILED');
  });

  it('supports delete and check', async () => {
    await kvs.entity<Order>('order').set('o1', order(1));
    await kvs.entity<Order>('order').set('o2', order(5));
    await kvs
      .transact()
      .delete('o1', { entityName: 'order' })
      .check('o2', { entityName: 'order', conditions: new Filter<Order>().and('rev', FilterConditions.equalTo(5)) })
      .execute();
    expect(emulator.getEntity('order', 'o1')).toBeUndefined();

    const failed = await codeOf(
      kvs
        .transact()
        .set('o3', order(1), { entityName: 'order' })
        .check('o2', { entityName: 'order', conditions: new Filter<Order>().and('rev', FilterConditions.equalTo(6)) })
        .execute()
    );
    expect(failed).toBe('CONDITION_CHECK_FAILED');
    expect(emulator.getEntity('order', 'o3')).toBeUndefined();
  });

  it('validates every value before writing anything', async () => {
    const code = await codeOf(
      kvs
        .transact()
        .set('o1', order(1), { entityName: 'order' })
        .set('o2', { ...order(1), status: '' }, { entityName: 'order' })
        .execute()
    );
    expect(code).toBe('EMPTY_PROPERTY_VALUE');
    expect(emulator.listEntities('order')).toEqual([]);
  });

  it('refuses the same key twice', async () => {
    const code = await codeOf(
      kvs.transact().set('o1', order(1), { entityName: 'order' }).delete('o1', { entityName: 'order' }).execute()
    );
    expect(code).toBe('INVALID_TRANSACTION');
  });

  it('mixes key-value and entity writes', async () => {
    await kvs.transact().set('counter', 1).set('o1', order(1), { entityName: 'order' }).execute();
    expect(emulator.getValue('counter')).toBe(1);
    expect(emulator.getEntity('order', 'o1')).toBeTruthy();
  });
});

describe('batches', () => {
  it('sets, gets and deletes, reporting failures per key', async () => {
    const set = await kvs.batchSet<unknown>([
      { key: 'a', value: 1 },
      { key: 'o1', value: order(), entityName: 'order' },
      { key: 'o2', value: { ...order(), status: '' }, entityName: 'order' },
      { key: 'bad/key', value: 1 }
    ]);
    expect(set.successfulKeys).toEqual([{ key: 'a' }, { key: 'o1', entityName: 'order' }]);
    expect(set.failedKeys.map((f) => [f.key, f.error.code])).toEqual([
      ['o2', 'EMPTY_PROPERTY_VALUE'],
      ['bad/key', 'INVALID_KEY']
    ]);

    const got = await kvs.batchGet([{ key: 'a' }, { key: 'o1', entityName: 'order' }, { key: 'missing' }]);
    expect(got.successfulKeys.map((r) => [r.key, r.value])).toEqual([
      ['a', 1],
      ['o1', order()]
    ]);
    expect(got.failedKeys.map((f) => [f.key, f.error.code])).toEqual([['missing', 'KEY_NOT_FOUND']]);

    const deleted = await kvs.batchDelete([{ key: 'a' }, { key: 'o1', entityName: 'order' }]);
    expect(deleted.failedKeys).toEqual([]);
    expect(emulator.listKeys()).toEqual([]);
  });

  it('enforces a configured batch size', async () => {
    const small = useLimitedEmulator();
    expect(await codeOf(kvs.batchSet([1, 2, 3].map((i) => ({ key: `k${i}`, value: i }))))).toBe('BATCH_TOO_LARGE');
    small.uninstall();
  });
});

function useLimitedEmulator() {
  return installKvsEmulator({ limits: { maxBatchItems: 2 } });
}
