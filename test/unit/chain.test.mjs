// Blocks, mining modes, the chain clock, the pending block and verifiable headers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'viem';
import { createBlockHeaderFromRPC } from '@ethereumjs/block';
import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import { bytesToHex } from '@ethereumjs/util';
import { boot, GENESIS_TS, sleep } from './helpers.mjs';

test('genesis: block 0 at the injected clock, funded accounts, chain id everywhere', async () => {
  const t = await boot({ chainId: 8453 });
  assert.equal(await t.rpc('eth_blockNumber'), '0x0');
  assert.equal(await t.rpc('eth_chainId'), '0x2105');
  assert.equal(await t.rpc('net_version'), '8453');
  assert.equal(await t.rpc('eth_syncing'), false);
  const b0 = await t.rpc('eth_getBlockByNumber', ['0x0', false]);
  assert.equal(Number(b0.timestamp), GENESIS_TS);
  assert.match(b0.hash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(await t.rpc('eth_getBlockByNumber', ['earliest', false]), b0);
  assert.equal(await t.rpc('eth_getBalance', [t.accounts[0], 'latest']), '0x' + (10_000n * 10n ** 18n).toString(16));
  assert.equal(t.sim.now(), BigInt(GENESIS_TS));
  assert.equal(t.sim.engine, 'revm');
});

test('auto mining: one block per transaction, receipts and tx lookups filled in', async () => {
  const t = await boot();
  const hash = await t.rpc('eth_sendTransaction', [{ from: t.accounts[0], to: t.accounts[1], value: '0x1' }]);
  assert.equal(await t.rpc('eth_blockNumber'), '0x1');
  const r = await t.rpc('eth_getTransactionReceipt', [hash]);
  assert.equal(r.status, '0x1'); assert.equal(r.blockNumber, '0x1'); assert.equal(r.gasUsed, '0x5208'); assert.equal(r.type, '0x2');
  const tx = await t.rpc('eth_getTransactionByHash', [hash]);
  assert.equal(tx.blockNumber, '0x1'); assert.equal(tx.hash, hash); assert.equal(tx.transactionIndex, '0x0');
  const full = await t.rpc('eth_getBlockByNumber', ['0x1', true]);
  assert.equal(full.transactions[0].hash, hash);
  assert.deepEqual((await t.rpc('eth_getBlockByNumber', ['latest', false])).transactions, [hash]);
  assert.deepEqual(await t.rpc('eth_getBlockByHash', [full.hash, false]), await t.rpc('eth_getBlockByNumber', ['0x1', false]));
  assert.equal(await t.rpc('eth_getBlockByNumber', ['0x7', false]), null);
  assert.equal(await t.rpc('eth_getTransactionReceipt', ['0x' + 'ab'.repeat(32)]), null);
});

test('manual mining: transactions wait in the pending block until evm_mine', async () => {
  const t = await boot();
  await t.rpc('evm_setAutomine', [false]);
  const hash = await t.rpc('eth_sendTransaction', [{ from: t.accounts[0], to: t.accounts[1], value: '0x1' }]);
  assert.equal(await t.rpc('eth_blockNumber'), '0x0');
  assert.equal(await t.rpc('eth_getTransactionReceipt', [hash]), null);
  const pending = await t.rpc('eth_getBlockByNumber', ['pending', false]);
  assert.equal(pending.number, '0x1'); assert.equal(pending.hash, null); assert.deepEqual(pending.transactions, [hash]);
  const receiptPromise = t.pub.waitForTransactionReceipt({ hash });
  await t.rpc('evm_mine');
  assert.equal((await receiptPromise).status, 'success');
  assert.equal(await t.rpc('eth_blockNumber'), '0x1');
});

test('interval mining mines on its own; instant mode stops the timer', async () => {
  const t = await boot();
  await t.rpc('evm_setIntervalMining', [20]);
  await sleep(120);
  const n = Number(await t.rpc('eth_blockNumber'));
  assert.ok(n >= 2, `expected blocks from the interval, got ${n}`);
  await t.rpc('evm_setAutomine', [true]);   // the dev bar's "Blocks: instant"
  const after = Number(await t.rpc('eth_blockNumber'));
  await sleep(80);
  assert.equal(Number(await t.rpc('eth_blockNumber')), after, 'the interval timer must stop');
  await t.rpc('evm_setIntervalMining', [20]); await sleep(60); await t.rpc('evm_setIntervalMining', [0]);
  const stopped = Number(await t.rpc('eth_blockNumber')); await sleep(60);
  assert.equal(Number(await t.rpc('eth_blockNumber')), stopped);
  t.sim.stop();
});

test('the chain clock: blocks advance one second at a time, increaseTime and setNextBlockTimestamp shift it', async () => {
  const t = await boot();
  await t.rpc('evm_mine');
  assert.equal(Number((await t.rpc('eth_getBlockByNumber', ['latest', false])).timestamp), GENESIS_TS + 1);
  assert.equal(await t.rpc('evm_increaseTime', [3600]), '0xe10');
  assert.equal(t.sim.now(), BigInt(GENESIS_TS + 3600));
  const pending = await t.rpc('eth_getBlockByNumber', ['pending', false]);
  assert.equal(Number(pending.timestamp), GENESIS_TS + 3600, 'the pending block carries the shifted clock');
  await t.rpc('evm_mine');
  assert.equal(Number((await t.rpc('eth_getBlockByNumber', ['latest', false])).timestamp), GENESIS_TS + 3600);
  await t.rpc('evm_setNextBlockTimestamp', [GENESIS_TS + 9999]);
  await t.rpc('evm_mine');
  assert.equal(Number((await t.rpc('eth_getBlockByNumber', ['latest', false])).timestamp), GENESIS_TS + 9999);
  await t.rpc('evm_mine');
  assert.equal(Number((await t.rpc('eth_getBlockByNumber', ['latest', false])).timestamp), GENESIS_TS + 10000, 'monotonic after a jump');
  assert.equal(await t.rpc('evm_increaseTime', [-3600]), '0x0', 'negative offsets are allowed (the Euler test travels back)');
});

test('fees: fixed base fee, gas price, fee history shape, custom base fee and gas limit', async () => {
  const t = await boot({ baseFeePerGas: 7n, blockGasLimit: 12_345_678n });
  assert.equal(await t.rpc('eth_gasPrice'), '0x8');
  assert.equal(await t.rpc('eth_maxPriorityFeePerGas'), '0x1');
  const b = await t.rpc('eth_getBlockByNumber', ['latest', false]);
  assert.equal(b.baseFeePerGas, '0x7'); assert.equal(b.gasLimit, '0xbc614e');
  await t.rpc('anvil_setNextBlockBaseFeePerGas', ['0x64']); await t.rpc('evm_mine');
  assert.equal((await t.rpc('eth_getBlockByNumber', ['latest', false])).baseFeePerGas, '0x64');
  const fh = await t.rpc('eth_feeHistory', ['0x2', 'latest', [50]]);
  assert.equal(fh.oldestBlock, '0x0'); assert.equal(fh.baseFeePerGas.length, 3); assert.equal(fh.gasUsedRatio.length, 2); assert.equal(fh.reward.length, 2);
});

test('verifiable headers: the hash recomputes from the RPC fields; merkle mode has a real, changing stateRoot', async () => {
  const t = await boot();
  const common = new Common({ chain: { ...Mainnet, chainId: 31337, name: 'verify' }, hardfork: Hardfork.Cancun });
  const root0 = (await t.rpc('eth_getBlockByNumber', ['0x0', false])).stateRoot;
  await t.rpc('eth_sendTransaction', [{ from: t.accounts[0], to: t.accounts[1], value: '0x' + parseEther('1').toString(16) }]);
  for (const n of ['0x0', '0x1']) {
    const b = await t.rpc('eth_getBlockByNumber', [n, false]);
    assert.equal(bytesToHex(createBlockHeaderFromRPC(b, { common, skipConsensusFormatValidation: true }).hash()), b.hash, `block ${n} hash`);
    assert.doesNotMatch(b.stateRoot, /^0x0+$/);
  }
  assert.notEqual((await t.rpc('eth_getBlockByNumber', ['0x1', false])).stateRoot, root0);
});

test('simple state mode reports the placeholder stateRoot', async () => {
  const t = await boot({ state: 'simple', stateRoot: '0x' + '11'.repeat(32) });
  await t.rpc('evm_mine');
  assert.equal((await t.rpc('eth_getBlockByNumber', ['latest', false])).stateRoot, '0x' + '11'.repeat(32));
  const plain = await boot({ state: 'simple' });
  assert.match((await plain.rpc('eth_getBlockByNumber', ['latest', false])).stateRoot, /^0x0{64}$/);
});

test('web3_clientVersion names the package version; eth_subscribe pushes new heads as message events', async () => {
  const t = await boot();
  assert.equal(await t.rpc('web3_clientVersion'), 'terrarium/0.3.0');
  assert.equal(await t.rpc('eth_subscribe', ['newHeads']), '0x1');
  const seen = []; t.sim.provider.on('message', (m) => seen.push(m));
  await t.rpc('evm_mine');
  assert.equal(seen[0].type, 'eth_subscription'); assert.equal(seen[0].data.result.number, '0x1');
  assert.equal(await t.rpc('eth_unsubscribe', ['0x1']), true);
});
