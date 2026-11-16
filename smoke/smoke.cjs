// Smoke test of the built CommonJS entry against the real @forge/kvs.
const assert = require('node:assert/strict');
const { installKvsEmulator } = require('../dist/index.cjs');
const { kvs } = require('@forge/kvs');

(async () => {
  const { emulator, uninstall } = installKvsEmulator({
    entities: [{ name: 'item', attributes: { title: { type: 'string' } }, indexes: ['title'] }]
  });
  await kvs.set('a', 1);
  assert.equal(await kvs.get('a'), 1);
  await kvs.entity('item').set('i1', { title: 'x' });
  await assert.rejects(kvs.entity('item').set('i2', { title: '' }), { code: 'EMPTY_PROPERTY_VALUE' });
  assert.deepEqual(emulator.listEntities('item'), [{ key: 'i1', value: { title: 'x' } }]);
  uninstall();
  console.log(`CJS smoke test passed on Node ${process.version}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
