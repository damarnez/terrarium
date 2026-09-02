// Logs, filters and event-reactive actors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, pad, parseEther, toHex, parseEventLogs } from 'viem';
import { boot, deployPepe, PEPE, rejects } from './helpers.mjs';

const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));

async function pond() {
  const t = await boot();
  const pepe = await deployPepe(t);
  const treasury = t.wallet(t.accounts[9]);
  const hashes = [];
  for (const [i, to] of [t.accounts[0], t.accounts[1], t.accounts[0]].entries()) hashes.push(await treasury.writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [to, parseEther(String(i + 1))] }));
  await t.pub.waitForTransactionReceipt({ hash: hashes.at(-1) });
  return { t, pepe, hashes };
}

test('eth_getLogs: by address, topic, indexed argument, block range and block hash; fields and indices', async () => {
  const { t, pepe } = await pond();
  const all = await t.rpc('eth_getLogs', [{ address: pepe }]);
  assert.equal(all.length, 4, 'mint + 3 transfers');
  assert.deepEqual(all.map((l) => l.blockNumber), ['0x1', '0x2', '0x3', '0x4']);
  assert.equal(all[1].logIndex, '0x0'); assert.equal(all[1].transactionIndex, '0x0'); assert.equal(all[1].removed, false); assert.equal(all[1].topics[0], TRANSFER);
  const toUser0 = await t.rpc('eth_getLogs', [{ address: pepe, topics: [TRANSFER, null, pad(t.accounts[0], { size: 32 })] }]);
  assert.equal(toUser0.length, 2);
  assert.equal((await t.rpc('eth_getLogs', [{ topics: [[TRANSFER, '0x' + 'ff'.repeat(32)]] }])).length, 4, 'topic alternatives');
  assert.equal((await t.rpc('eth_getLogs', [{ fromBlock: '0x2', toBlock: '0x3' }])).length, 2);
  assert.equal((await t.rpc('eth_getLogs', [{ fromBlock: '0x4', toBlock: 'latest' }])).length, 1);
  const b3 = await t.rpc('eth_getBlockByNumber', ['0x3', false]);
  assert.equal((await t.rpc('eth_getLogs', [{ blockHash: b3.hash }]))[0].blockHash, b3.hash);
  assert.equal((await t.rpc('eth_getLogs', [{ address: t.accounts[7] }])).length, 0);
  const decoded = parseEventLogs({ abi: PEPE.abi, logs: await t.pub.getLogs({ address: pepe }) });
  assert.equal(decoded[3].args.value, parseEther('3'));
});

test('filters: log, block and pending filters, cursors, uninstall', async () => {
  const { t, pepe } = await pond();
  const f = await t.rpc('eth_newFilter', [{ address: pepe, topics: [TRANSFER] }]);
  const bf = await t.rpc('eth_newBlockFilter');
  const pf = await t.rpc('eth_newPendingTransactionFilter');
  assert.deepEqual(await t.rpc('eth_getFilterChanges', [f]), [], 'nothing since installation');
  await t.wallet(t.accounts[9]).writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [t.accounts[2], 1n] });
  await t.rpc('evm_mine');
  const changes = await t.rpc('eth_getFilterChanges', [f]);
  assert.equal(changes.length, 1); assert.equal(changes[0].blockNumber, '0x5');
  assert.deepEqual(await t.rpc('eth_getFilterChanges', [f]), []);
  const heads = await t.rpc('eth_getFilterChanges', [bf]);
  assert.equal(heads.length, 2); assert.equal(heads[1], (await t.rpc('eth_getBlockByNumber', ['latest', false])).hash);
  assert.deepEqual(await t.rpc('eth_getFilterChanges', [pf]), []);
  assert.equal((await t.rpc('eth_getFilterLogs', [f])).length, 5, 'all matching logs, ever');
  assert.equal(await t.rpc('eth_uninstallFilter', [f]), true);
  await rejects(t.rpc('eth_getFilterChanges', [f]), (e) => { assert.equal(e.code, -32000); assert.match(e.message, /filter not found/); });
});

test('onLog actors run after the block, receive the log, and can be unsubscribed', async () => {
  const { t, pepe } = await pond();
  const seen = [];
  const off = t.sim.onLog({ address: pepe, topics: [TRANSFER] }, (log, meta) => seen.push({ log, meta }));
  await t.wallet(t.accounts[9]).writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [t.accounts[2], 5n] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen.length, 1); assert.equal(seen[0].meta.blockNumber, 5n); assert.equal(seen[0].log.address.toLowerCase(), pepe.toLowerCase());
  off();
  await t.wallet(t.accounts[9]).writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [t.accounts[2], 5n] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(seen.length, 1);
});

test('an actor reacting to a log with a transaction of its own: the classic keeper loop', async () => {
  const { t, pepe } = await pond();
  t.sim.onLog({ address: pepe, topics: [TRANSFER, null, pad(t.accounts[2], { size: 32 })] }, () => t.sim.sendAs(t.accounts[2], { to: t.accounts[3], value: '0x1' }));
  const before = Number(await t.rpc('eth_blockNumber'));
  await t.wallet(t.accounts[9]).writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [t.accounts[2], 5n] });
  for (let i = 0; i < 50 && Number(await t.rpc('eth_blockNumber')) < before + 2; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(Number(await t.rpc('eth_blockNumber')), before + 2, 'the reaction landed in its own block');
});
