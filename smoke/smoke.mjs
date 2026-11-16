// Smoke test of the built ES module entry against the real @forge/kvs.
import assert from 'node:assert/strict';
import { installKvsEmulator } from '../dist/index.js';
import { kvs } from '@forge/kvs';

const { emulator, uninstall } = installKvsEmulator({
  entities: [{ name: 'item', attributes: { title: { type: 'string' } }, indexes: ['title'] }]
});
await kvs.entity('item').set('i1', { title: 'x' });
const { results } = await kvs.entity('item').query().index('title').getMany();
assert.deepEqual(
  results.map((r) => r.key),
  ['i1']
);
assert.equal(emulator.requests.length, 2);
uninstall();
console.log(`ESM smoke test passed on Node ${process.version}`);
