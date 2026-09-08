// Persistence: dump/restore, auto-save through any getItem/setItem store, precedence of persisted state over a
// baseline, journal replay, pruning, determinism (seed + clock).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'viem';
import { createTerrarium } from '@terrariumlabs/core/engine';
import { boot, deployPepe, PEPE, memoryStorage, sleep, GENESIS_TS, until } from './helpers.mjs';

async function populated(extra = {}) {
  const t = await boot(extra);
  const pepe = await deployPepe(t);
  await t.wallet(t.accounts[9]).writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [t.accounts[0], parseEther('3')] });
  await t.rpc('evm_increaseTime', [100]); await t.rpc('evm_mine');
  return { t, pepe };
}
const bal = (t, pepe, who) => t.pub.readContract({ address: pepe, abi: PEPE.abi, functionName: 'balanceOf', args: [who] });

test('dumpState → restore: blocks, receipts, logs, code and balances come back and the chain keeps going', async () => {
  const { t, pepe } = await populated();
  const dump = await t.sim.dumpState();
  assert.equal(dump.version, 1); assert.equal(dump.chain.blocks.length, 4); assert.equal(dump.remote, undefined);
  const head = await t.rpc('eth_getBlockByNumber', ['latest', false]);
  const b = await boot({ restore: dump });
  assert.equal(b.sim.blockNumber, 3n); assert.equal(b.sim.restoredFromPersistence, false);
  assert.deepEqual(await b.rpc('eth_getBlockByNumber', ['latest', false]), head);
  assert.equal(await bal(b, pepe, b.accounts[0]), parseEther('3'));
  assert.equal(await b.rpc('eth_getCode', [pepe, 'latest']), await t.rpc('eth_getCode', [pepe, 'latest']));
  const [r] = (await b.rpc('eth_getBlockByNumber', ['0x2', false])).transactions;
  assert.equal((await b.rpc('eth_getTransactionReceipt', [r])).logs.length, 1, 'receipt logs rebuilt from block logs');
  assert.equal((await b.rpc('eth_getLogs', [{ address: pepe }])).length, 2);
  assert.equal(b.sim.now(), BigInt(GENESIS_TS + 100), 'the clock offset is part of the dump');
  const hash = await b.wallet(b.accounts[0]).writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [b.accounts[1], parseEther('1')] });
  assert.equal((await b.pub.waitForTransactionReceipt({ hash })).status, 'success');
  assert.equal(await bal(b, pepe, b.accounts[1]), parseEther('1'));
});

test('persist: auto-saved after a debounce, flush() forces it, a second boot restores from the store', async () => {
  const storage = memoryStorage();
  const { t, pepe } = await populated({ persist: { storage, debounceMs: 10 } });
  await until(() => storage.map.has('terrarium:31337'), 3000, 'the debounced auto-save'); assert.ok(storage.map.has('terrarium:31337'), 'default key');
  await t.rpc('evm_mine'); await t.sim.flush();
  assert.equal(JSON.parse(storage.map.get('terrarium:31337')).chain.blockCount, 5); assert.equal(JSON.parse(storage.map.get('terrarium:31337:b0')).length, 5, 'blocks live in chunk keys');
  const b = await boot({ persist: { storage } });
  assert.equal(b.sim.restoredFromPersistence, true); assert.equal(b.sim.blockNumber, 4n);
  assert.equal(await bal(b, pepe, b.accounts[0]), parseEther('3'));
  t.sim.stop(); b.sim.stop();
});

test('persisted state wins over restore; restore is the baseline only when the store is empty', async () => {
  const { t } = await populated();
  const baseline = await t.sim.dumpState();
  const storage = memoryStorage();
  const a = await boot({ persist: { storage, key: 'k' }, restore: baseline });
  assert.equal(a.sim.blockNumber, 3n); assert.equal(a.sim.restoredFromPersistence, false);
  await a.rpc('evm_mine'); await a.sim.flush();
  const b = await boot({ persist: { storage, key: 'k' }, restore: baseline });
  assert.equal(b.sim.blockNumber, 4n); assert.equal(b.sim.restoredFromPersistence, true);
  a.sim.stop(); b.sim.stop();
});

test('journal: only state-changing calls are recorded; replaying it rebuilds identical blocks', async () => {
  const { t } = await populated();
  await t.rpc('eth_call', [{ to: t.accounts[0], data: '0x' }, 'latest']); await t.rpc('eth_blockNumber');
  const methods = t.sim.journal.map((e) => e.method);
  assert.deepEqual(methods, ['eth_sendTransaction', 'eth_sendTransaction', 'evm_increaseTime', 'evm_mine']);
  const dump = await t.sim.dumpState();
  const fresh = await boot();
  await fresh.sim.replayJournal(dump.journal);
  assert.equal(fresh.sim.blockNumber, 3n);
  for (const n of ['0x1', '0x2', '0x3']) assert.equal((await fresh.rpc('eth_getBlockByNumber', [n, false])).hash, (await t.rpc('eth_getBlockByNumber', [n, false])).hash, `block ${n}`);
  assert.equal(fresh.sim.journal.length, 0, 'a replay is not re-recorded');
});

test('maxTxBlocks prunes old transaction bodies from the dump (blocks and logs stay)', async () => {
  const storage = memoryStorage();
  const { t } = await populated({ persist: { storage, maxTxBlocks: 0 } });
  const dump = await t.sim.dumpState();
  assert.equal(Object.keys(dump.chain.txs).length, 0, 'the last block is empty, so no bodies are kept');
  await t.rpc('eth_sendTransaction', [{ from: t.accounts[0], to: t.accounts[1], value: '0x1' }]);
  assert.equal(Object.keys((await t.sim.dumpState()).chain.txs).length, 1);
  assert.equal((await t.sim.dumpState()).chain.blocks.length, 5);
  t.sim.stop();
});

test('determinism: same seed → same random sequence; the clock is injectable', async () => {
  const a = await createTerrarium({ seed: 42, clock: () => 5 }), b = await createTerrarium({ seed: 42, clock: () => 5 }), c = await createTerrarium({ seed: 43, clock: () => 5 });
  const seq = (s) => Array.from({ length: 5 }, () => s.random());
  assert.deepEqual(seq(a), seq(b)); assert.notDeepEqual(seq(a), seq(c));
  assert.equal(a.seed, 42); assert.equal(a.now(), 5n);
  assert.equal(Number((await a.provider.request({ method: 'eth_getBlockByNumber', params: ['0x0', false] })).timestamp), 5);
});

test('incremental persistence: a save rewrites only the dirty block chunks and the core; a revert drops chunks; a legacy whole dump still loads; clearPersisted removes everything', async () => {
  const storage = memoryStorage(); const writes = [];
  const spy = { ...storage, setItem: async (k, v) => { writes.push(k); return storage.setItem(k, v); } };
  const t = await boot({ persist: { storage: spy, key: 'k' } });
  const [a, b] = t.accounts;
  for (let i = 0; i < 130; i++) await t.rpc('eth_sendTransaction', [{ from: a, to: b, value: '0x1' }]);   // 130 blocks = chunks b0 (64), b1 (64), b2 (2)
  await t.sim.flush();
  assert.deepEqual([...storage.map.keys()].sort(), ['k', 'k:b0', 'k:b1', 'k:b2']);
  assert.equal(JSON.parse(storage.map.get('k')).chain.blockCount, 131); assert.equal(JSON.parse(storage.map.get('k:b2')).length, 3);
  writes.length = 0;
  await t.rpc('eth_sendTransaction', [{ from: a, to: b, value: '0x1' }]); await t.sim.flush();
  assert.deepEqual(writes, ['k:b2', 'k'], 'one more block: only the last chunk and the core are written');
  const snap = await t.rpc('evm_snapshot'); for (let i = 0; i < 70; i++) await t.rpc('evm_mine'); await t.sim.flush();
  assert.ok(storage.map.has('k:b3'), 'grew into a fourth chunk');
  writes.length = 0; await t.rpc('evm_revert', [snap]); await t.sim.flush();
  assert.equal(storage.map.has('k:b3'), false, 'the revert removed the chunk past the head'); assert.deepEqual(writes, ['k:b2', 'k']);
  // a second engine restores the same chain from core + chunks
  const t2 = await boot({ persist: { storage, key: 'k' } });
  assert.equal(t2.sim.blockNumber, t.sim.blockNumber); assert.equal(t2.sim.restoredFromPersistence, true);
  assert.equal((await t2.rpc('eth_getBlockByNumber', ['0x5', false])).hash, (await t.rpc('eth_getBlockByNumber', ['0x5', false])).hash);
  // a legacy value (the whole dump under the key) loads, and the next save converts it
  const legacy = memoryStorage(); await legacy.setItem('L', JSON.stringify(await t.sim.dumpState()));
  const t3 = await boot({ persist: { storage: legacy, key: 'L' } });
  assert.equal(t3.sim.blockNumber, t.sim.blockNumber); await t3.sim.flush();
  assert.ok(legacy.map.has('L:b0') && JSON.parse(legacy.map.get('L')).chain.blockCount === Number(t.sim.blockNumber) + 1, 'converted to chunks');
  await t3.sim.clearPersisted(); assert.deepEqual([...legacy.map.keys()], [], 'clearPersisted removed the core and every chunk');
  t.sim.stop(); t2.sim.stop(); t3.sim.stop();
});
