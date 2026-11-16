/**
 * The emulator's own API: installation, seeding, snapshots, fault injection,
 * request log, latency and schema validation.
 */

import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ForgeKvsAPIError, kvs } from '@forge/kvs';
import {
  EmulatorConfigError,
  KvsEmulator,
  buildSchema,
  createKvsEmulator,
  entitiesFromManifest,
  installKvsEmulator,
  loadManifestEntities,
  type InstalledKvsEmulator
} from '../src/index.js';

const manifestPath = fileURLToPath(new URL('./fixtures/manifest.yml', import.meta.url));
const order = { customerId: 'c1', status: 'open', createdAt: '2026-01-01' };

let installed: InstalledKvsEmulator | undefined;
afterEach(() => {
  installed?.uninstall();
  installed = undefined;
});

const install = (options = {}) => {
  installed = installKvsEmulator({ manifestPath, ...options });
  return installed.emulator;
};

describe('installation', () => {
  it('answers @forge/kvs and passes other request types on', async () => {
    const calls: string[] = [];
    const g = globalThis as unknown as { __forge_fetch__?: unknown };
    g.__forge_fetch__ = async (descriptor: { type: string }, path: string) => {
      calls.push(`${descriptor.type} ${path}`);
      return new Response('{}');
    };
    const emulator = install();
    await kvs.set('a', 1);
    expect(emulator.getValue('a')).toBe(1);
    const forgeFetch = g.__forge_fetch__ as (d: unknown, p: string) => Promise<Response>;
    await forgeFetch({ type: 'fpp' }, '/rest/api/3/myself');
    expect(calls).toEqual(['fpp /rest/api/3/myself']);

    installed!.uninstall();
    installed = undefined;
    expect(typeof g.__forge_fetch__).toBe('function');
    await (g.__forge_fetch__ as (d: unknown, p: string) => Promise<Response>)({ type: 'kvs' }, '/api/v1/get');
    expect(calls).toHaveLength(2);
    delete g.__forge_fetch__;
  });

  it('fails clearly for non-KVS requests when nothing else is installed', async () => {
    install();
    const g = globalThis as unknown as { __forge_fetch__: (d: unknown, p: string) => Promise<Response> };
    await expect(g.__forge_fetch__({ type: 'fpp' }, '/x')).rejects.toThrow(/no handler/);
  });

  it('can be used directly as a fetch client', async () => {
    const emulator = createKvsEmulator();
    const response = await emulator.fetch('/api/v1/set', {
      method: 'POST',
      body: JSON.stringify({ key: 'k', value: 'v' })
    });
    expect(response.status).toBe(204);
    const read = await emulator.fetch('/api/v1/get', { method: 'POST', body: JSON.stringify({ key: 'k' }) });
    expect(await read.json()).toMatchObject({ key: 'k', value: 'v' });
    const unknown = await emulator.fetch('/api/v1/unknown', { method: 'POST', body: '{}' });
    expect(unknown.status).toBe(404);
    const bad = await emulator.fetch('/api/v1/get', { method: 'POST', body: '{not json' });
    expect((await bad.json()).code).toBe('INVALID_REQUEST');
  });
});

describe('test API', () => {
  it('seeds data through the same validation as real writes', async () => {
    const emulator = install();
    emulator.seedValue('config', { on: true });
    emulator.seedSecret('token', 'x');
    emulator.seedEntity('order', 'o1', order);
    expect(await kvs.get('config')).toEqual({ on: true });
    expect(await kvs.getSecret('token')).toBe('x');
    expect(await kvs.entity('order').get('o1')).toEqual(order);
    expect(() => emulator.seedEntity('order', 'o2', { ...order, status: '' })).toThrow(/cannot be empty/);
    expect(emulator.entityNames).toEqual(['order', 'audit-log']);
  });

  it('snapshots and restores the whole store', async () => {
    const emulator = install();
    await kvs.set('a', 1);
    await kvs.entity('order').set('o1', order);
    const snapshot = emulator.snapshot();
    await kvs.set('a', 2);
    await kvs.entity('order').delete('o1');
    emulator.restore(snapshot);
    expect(await kvs.get('a')).toBe(1);
    expect(emulator.listEntities('order')).toEqual([{ key: 'o1', value: order }]);
  });

  it('injects faults into matching requests, a given number of times', async () => {
    const emulator = install();
    emulator.failNext('set', { status: 503, code: 'SERVICE_UNAVAILABLE' }, { times: 2 });
    for (let i = 0; i < 2; i += 1) {
      const error = await kvs.set('a', 1).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForgeKvsAPIError);
      expect((error as ForgeKvsAPIError).code).toBe('SERVICE_UNAVAILABLE');
      expect((error as ForgeKvsAPIError).responseDetails.status).toBe(503);
    }
    await kvs.set('a', 1);

    emulator.failNext((operation, body) => operation === 'entity.set' && (body as { key: string }).key === 'o2', {
      code: 'RATE_LIMIT_EXCEEDED',
      status: 429
    });
    await kvs.entity('order').set('o1', order);
    await expect(kvs.entity('order').set('o2', order)).rejects.toMatchObject({ code: 'RATE_LIMIT_EXCEEDED' });
  });

  it('records requests for assertions', async () => {
    const emulator = install();
    await kvs.set('a', 1);
    await kvs.get('missing');
    expect(emulator.requests.map((r) => [r.operation, r.status, r.code])).toEqual([
      ['set', 204, undefined],
      ['get', 404, 'KEY_NOT_FOUND']
    ]);
    emulator.reset();
    expect(emulator.requests).toEqual([]);
    expect(emulator.listKeys()).toEqual([]);
  });

  it('can stop recording requests', async () => {
    const emulator = install({ recordRequests: false });
    await kvs.set('a', 1);
    expect(emulator.requests).toEqual([]);
  });

  it('interleaves concurrent requests by default', async () => {
    install();
    const order: string[] = [];
    await Promise.all([kvs.set('a', 1).then(() => order.push('a')), Promise.resolve().then(() => order.push('sync'))]);
    expect(order).toEqual(['sync', 'a']);
  });

  it('supports millisecond latency and a custom clock', async () => {
    let now = Date.parse('2030-01-01T00:00:00Z');
    install({ latency: 5, now: () => now });
    const started = Date.now();
    await kvs.set('t', 1, { ttl: { value: 1, unit: 'HOURS' } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
    now += 3_600_001;
    expect(await kvs.get('t')).toBeUndefined();
  });

  it('accepts undeclared attributes when allowed', async () => {
    install({ allowUnknownAttributes: true });
    await kvs.entity('order').set('o1', { ...order, extra: 1 });
    expect(await kvs.entity('order').get('o1')).toMatchObject({ extra: 1 });
  });

  it('works with latency 0', async () => {
    install({ latency: 0 });
    await kvs.set('a', 1);
    expect(await kvs.get('a')).toBe(1);
  });
});

describe('schema validation', () => {
  it('loads entities from a manifest file', () => {
    expect(loadManifestEntities(manifestPath).map((e) => e.name)).toEqual(['order', 'audit-log']);
    expect(entitiesFromManifest({})).toEqual([]);
    expect(() => entitiesFromManifest({ app: { storage: { entities: {} } } })).toThrow(EmulatorConfigError);
    expect(() => loadManifestEntities('/no/such/manifest.yml')).toThrow(/Could not read the manifest/);
  });

  const attrs = { a: { type: 'string' as const } };
  const invalid: Array<[string, unknown]> = [
    ['bad entity name', [{ name: 'Bad', attributes: attrs }]],
    [
      'duplicate entity',
      [
        { name: 'abc', attributes: attrs },
        { name: 'abc', attributes: attrs }
      ]
    ],
    ['no attributes', [{ name: 'abc', attributes: {} }]],
    ['long attribute name', [{ name: 'abc', attributes: { ['x'.repeat(31)]: { type: 'string' } } }]],
    ['unknown type', [{ name: 'abc', attributes: { a: { type: 'date' } } }]],
    ['index on any', [{ name: 'abc', attributes: { a: { type: 'any' } }, indexes: ['a'] }]],
    ['index on undeclared', [{ name: 'abc', attributes: attrs, indexes: [{ name: 'by-b', range: ['b'] }] }]],
    [
      'two range attributes',
      [
        {
          name: 'abc',
          attributes: { a: { type: 'string' }, b: { type: 'string' } },
          indexes: [{ name: 'ix-ab', range: ['a', 'b'] }]
        }
      ]
    ],
    ['duplicate index', [{ name: 'abc', attributes: attrs, indexes: ['a', 'a'] }]],
    [
      'too many indexes',
      [
        {
          name: 'abc',
          attributes: attrs,
          indexes: Array.from({ length: 8 }, (_, i) => ({ name: `ix-${i}`, range: ['a'] }))
        }
      ]
    ],
    [
      'too many attributes',
      [
        {
          name: 'abc',
          attributes: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`a${i}`, { type: 'string' }]))
        }
      ]
    ],
    ['too many entities', Array.from({ length: 21 }, (_, i) => ({ name: `entity-${i}`, attributes: attrs }))]
  ];
  for (const [label, definitions] of invalid) {
    it(`refuses: ${label}`, () => {
      expect(() => buildSchema(definitions as never)).toThrow(EmulatorConfigError);
    });
  }

  it('builds a valid schema', () => {
    expect(new KvsEmulator({ entities: [{ name: 'abc', attributes: attrs, indexes: ['a'] }] }).entityNames).toEqual([
      'abc'
    ]);
  });
});
