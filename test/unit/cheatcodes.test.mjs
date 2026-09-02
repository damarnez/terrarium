// Anvil / Hardhat cheatcodes, snapshots that roll back everything, and viem's test client on top of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestClient, custom, parseEther } from 'viem';
import { boot, deployPepe, PEPE, GENESIS_TS } from './helpers.mjs';

test('setBalance / setNonce / setCode / setStorageAt under both prefixes', async () => {
  const t = await boot();
  const a = t.accounts[4];
  await t.rpc('anvil_setBalance', [a, '0x64']); assert.equal(await t.rpc('eth_getBalance', [a, 'latest']), '0x64');
  await t.rpc('hardhat_setBalance', [a, '0xc8']); assert.equal(await t.rpc('eth_getBalance', [a, 'latest']), '0xc8');
  await t.rpc('anvil_setNonce', [a, '0x9']); assert.equal(await t.rpc('eth_getTransactionCount', [a, 'latest']), '0x9');
  await t.rpc('hardhat_setCode', [a, '0x6001']); assert.equal(await t.rpc('eth_getCode', [a, 'latest']), '0x6001');
  await t.rpc('anvil_setStorageAt', [a, '0x1', '0x2a']);
  assert.equal(await t.rpc('eth_getStorageAt', [a, '0x1', 'latest']), '0x' + '2a'.padStart(64, '0'));
  assert.equal(await t.rpc('eth_getStorageAt', [a, '0x2', 'latest']), '0x' + '0'.repeat(64));
});

test('snapshot / revert rolls back state, blocks, receipts, the clock, the base fee and filter cursors', async () => {
  const t = await boot();
  const pepe = await deployPepe(t);
  const bal = (who) => t.pub.readContract({ address: pepe, abi: PEPE.abi, functionName: 'balanceOf', args: [who] });
  const snap = await t.rpc('evm_snapshot');
  const headBefore = await t.rpc('eth_getBlockByNumber', ['latest', false]);
  const filter = await t.rpc('eth_newFilter', [{ address: pepe }]);
  const hash = await t.wallet(t.accounts[9]).writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [t.accounts[0], parseEther('1')] });
  await t.rpc('evm_increaseTime', [3600]); await t.rpc('anvil_setNextBlockBaseFeePerGas', ['0x5']); await t.rpc('evm_mine');
  assert.equal(await bal(t.accounts[0]), parseEther('1'));
  assert.equal((await t.rpc('eth_getFilterChanges', [filter])).length, 1);
  assert.equal(await t.rpc('evm_revert', [snap]), true);
  assert.deepEqual(await t.rpc('eth_getBlockByNumber', ['latest', false]), headBefore);
  assert.equal(await bal(t.accounts[0]), 0n);
  assert.equal(await t.rpc('eth_getTransactionReceipt', [hash]), null, 'the receipt of a reverted-away tx is gone');
  assert.equal(t.sim.now(), BigInt(GENESIS_TS), 'the clock offset is state too');
  assert.equal(await t.rpc('eth_gasPrice'), '0x3b9aca01', 'base fee restored');
  assert.deepEqual(await t.rpc('eth_getFilterChanges', [filter]), [], 'the filter cursor is clamped, not broken');
  await t.rpc('evm_mine');
  assert.equal(await t.rpc('eth_blockNumber'), '0x2');
  assert.equal(await t.rpc('evm_revert', ['0x99']), false);
});

test('nested snapshots revert to the chosen level; sim.snapshot()/revert() are the same thing', async () => {
  const t = await boot();
  const s1 = await t.sim.snapshot(); await t.rpc('evm_mine');
  const s2 = await t.sim.snapshot(); await t.rpc('evm_mine'); await t.rpc('evm_mine');
  assert.equal(await t.rpc('eth_blockNumber'), '0x3');
  await t.sim.revert(s2); assert.equal(await t.rpc('eth_blockNumber'), '0x1');
  await t.sim.revert(s1); assert.equal(await t.rpc('eth_blockNumber'), '0x0');
});

test("viem's createTestClient({ mode: 'anvil' }) drives the chain unchanged", async () => {
  const t = await boot();
  const tc = createTestClient({ mode: 'anvil', chain: t.chain, transport: custom(t.sim.provider) });
  await tc.setBalance({ address: t.accounts[2], value: parseEther('3') });
  assert.equal(await t.pub.getBalance({ address: t.accounts[2] }), parseEther('3'));
  await tc.mine({ blocks: 2 });
  assert.equal(await t.pub.getBlockNumber(), 2n);
  await tc.increaseTime({ seconds: 60 });
  const id = await tc.snapshot(); await tc.mine({ blocks: 1 }); await tc.revert({ id });
  assert.equal(await t.pub.getBlockNumber(), 2n);
  await tc.impersonateAccount({ address: '0x00000000000000000000000000000000000000C3' });
  await tc.setStorageAt({ address: t.accounts[2], index: 0, value: '0x' + '1'.padStart(64, '0') });
  assert.equal(await t.pub.getStorageAt({ address: t.accounts[2], slot: '0x0' }), '0x' + '1'.padStart(64, '0'));
  await tc.setAutomine(false); await tc.setIntervalMining({ interval: 0 });
});
