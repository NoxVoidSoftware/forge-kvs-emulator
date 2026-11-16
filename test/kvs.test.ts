/**
 * Key-value store and secrets, through the real @forge/kvs client.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForgeKvsAPIError, MetadataField, WhereConditions, kvs } from '@forge/kvs';
import { useKvsEmulator } from '../src/index.js';

const emulator = useKvsEmulator({ entities: [] }, { beforeEach, afterAll });

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ForgeKvsAPIError);
  expect((error as ForgeKvsAPIError).code).toBe(code);
}

describe('key-value store', () => {
  it('stores, reads and deletes values of every JSON type', async () => {
    const values = ['text', 42, 1.5, true, false, { nested: { list: [1, 'a'] } }, [1, 2, 3]];
    for (const [i, value] of values.entries()) await kvs.set(`k${i}`, value);
    for (const [i, value] of values.entries()) expect(await kvs.get(`k${i}`)).toEqual(value);

    await kvs.delete('k0');
    expect(await kvs.get('k0')).toBeUndefined();
    // Deleting a missing key is not an error.
    await kvs.delete('never-existed');
  });

  it('returns undefined for missing keys', async () => {
    expect(await kvs.get('missing')).toBeUndefined();
  });

  it('isolates stored values from later mutation', async () => {
    const value = { list: [1] };
    await kvs.set('obj', value);
    value.list.push(2);
    const read = await kvs.get<{ list: number[] }>('obj');
    read!.list.push(3);
    expect(await kvs.get('obj')).toEqual({ list: [1] });
  });

  it('returns metadata when asked', async () => {
    emulator.advanceTime(0);
    await kvs.set('meta', 'v');
    const result = await kvs.get('meta', { metadataFields: [MetadataField.CREATED_AT, MetadataField.UPDATED_AT] });
    expect(result).toMatchObject({ key: 'meta', value: 'v' });
    expect(typeof result!.createdAt).toBe('number');
    expect(typeof result!.updatedAt).toBe('number');
  });

  it('keeps createdAt and moves updatedAt on overwrite', async () => {
    await kvs.set('meta', 1);
    const first = await kvs.get('meta', { metadataFields: [MetadataField.CREATED_AT, MetadataField.UPDATED_AT] });
    emulator.advanceTime(5000);
    await kvs.set('meta', 2);
    const second = await kvs.get('meta', { metadataFields: [MetadataField.CREATED_AT, MetadataField.UPDATED_AT] });
    expect(second!.createdAt).toBe(first!.createdAt);
    expect(second!.updatedAt).toBeGreaterThanOrEqual(first!.updatedAt! + 5000);
  });

  it('honours keyPolicy FAIL_IF_EXISTS', async () => {
    await kvs.set('once', 1, { keyPolicy: 'FAIL_IF_EXISTS' });
    await expectCode(kvs.set('once', 2, { keyPolicy: 'FAIL_IF_EXISTS' }), 'KEY_ALREADY_EXISTS');
    expect(await kvs.get('once')).toBe(1);
  });

  it('returns the previous or latest value on request', async () => {
    expect(await kvs.set('r', 1, { keyPolicy: 'OVERRIDE', returnValue: 'PREVIOUS' })).toBeUndefined();
    expect(await kvs.set('r', 2, { keyPolicy: 'OVERRIDE', returnValue: 'PREVIOUS' })).toEqual({ key: 'r', value: 1 });
    expect(await kvs.set('r', 3, { keyPolicy: 'OVERRIDE', returnValue: 'LATEST' })).toEqual({ key: 'r', value: 3 });
  });

  it('expires values with a TTL', async () => {
    await kvs.set('session', 'abc', { ttl: { value: 10, unit: 'MINUTES' } });
    const withTtl = await kvs.get('session', { metadataFields: [MetadataField.EXPIRE_TIME] });
    expect(withTtl!.expireTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    emulator.advanceTime(9 * 60_000);
    expect(await kvs.get('session')).toBe('abc');
    emulator.advanceTime(2 * 60_000);
    expect(await kvs.get('session')).toBeUndefined();
  });

  it('validates keys like Forge', async () => {
    await expectCode(kvs.set('', 1), 'EMPTY_KEY');
    await expectCode(kvs.set('x'.repeat(501), 1), 'KEY_TOO_LONG');
    await expectCode(kvs.set('slash/not-allowed', 1), 'INVALID_KEY');
    await expectCode(kvs.set('   ', 1), 'INVALID_KEY');
    await kvs.set('ok:key_1.2-#3 with space', 1);
  });

  it('validates values like Forge', async () => {
    await expectCode(kvs.set('big', 'x'.repeat(240 * 1024 + 1)), 'MAX_SIZE');
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 40; i += 1) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    await expectCode(kvs.set('deep', root), 'MAX_DEPTH');
    await expectCode(kvs.set('null', null), 'INVALID_VALUE');
  });

  it('queries keys by prefix in key order, page by page', async () => {
    for (const key of ['user:3', 'user:1', 'user:2', 'other:1']) await kvs.set(key, key);
    const first = await kvs.query().where('key', WhereConditions.beginsWith('user:')).limit(2).getMany();
    expect(first.results.map((r) => r.key)).toEqual(['user:1', 'user:2']);
    expect(first.nextCursor).toBeTruthy();
    const second = await kvs
      .query()
      .where('key', WhereConditions.beginsWith('user:'))
      .limit(2)
      .cursor(first.nextCursor!)
      .getMany();
    expect(second.results.map((r) => r.key)).toEqual(['user:3']);
    expect(second.nextCursor).toBeUndefined();
    expect(await kvs.query().where('key', WhereConditions.beginsWith('other')).getOne()).toEqual({
      key: 'other:1',
      value: 'other:1'
    });
  });

  it('rejects cursors it did not issue', async () => {
    await expectCode(kvs.query().cursor('not-a-cursor').getMany(), 'INVALID_CURSOR');
  });
});

describe('secrets', () => {
  it('are stored apart from key-value data', async () => {
    await kvs.setSecret('token', { value: 's3cr3t' });
    expect(await kvs.getSecret('token')).toEqual({ value: 's3cr3t' });
    expect(await kvs.get('token')).toBeUndefined();
    expect((await kvs.query().getMany()).results).toEqual([]);
    expect(emulator.getSecret('token')).toEqual({ value: 's3cr3t' });
    await kvs.deleteSecret('token');
    expect(await kvs.getSecret('token')).toBeUndefined();
  });
});
