// The transaction explorer's data: the engine lists transactions newest first with receipt, status word, revert
// reason/data and block timestamp (sim.transactions / terrarium_transactions); the scenario runtime decodes calls,
// events and custom errors with the scenario's ABIs and names addresses with `labels`.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'viem';
import { runScenario } from '@terrariumlabs/core/worker';
import { boot, deployPepe, PEPE, GENESIS_TS, memoryStorage } from './helpers.mjs';

before(() => { globalThis.postMessage = () => {}; });

test('engine: newest first, status words (success / reverted / dropped / pending), revert data kept, timestamps, paging, survives dump/load', async () => {
  const storage = memoryStorage();
  const t = await boot({ persist: { storage, key: 'x' } });
  const [me, other] = t.accounts;
  const pepe = await deployPepe(t, me);
  const ok = await t.wallet(me).writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [other, parseEther('1')] });
  await t.pub.waitForTransactionReceipt({ hash: ok });
  // a revert: `other` has 1 PEPE and sends 2 (a real custom error, InsufficientBalance); gas given explicitly so estimation does not refuse it
  const bad = await t.wallet(other).writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [me, parseEther('2')], gas: 100000n });
  await t.pub.waitForTransactionReceipt({ hash: bad });
  // a dropped tx: wrong nonce, signed raw (never executes; failed receipt so nobody hangs)
  const signer = t.wallet(t.sim.accounts[1]);   // the sim's accounts are viem local accounts: they sign in-process
  const raw = await signer.signTransaction(await signer.prepareTransactionRequest({ to: me, value: 1n, nonce: 7, gas: 21000n, chain: t.chain }));
  const dropped = await t.rpc('eth_sendRawTransaction', [raw]);

  const { total, transactions } = t.sim.transactions();
  assert.equal(total, 4);
  assert.deepEqual(transactions.map((x) => x.status), ['dropped', 'reverted', 'success', 'success']);
  assert.deepEqual(transactions.map((x) => x.hash), [dropped, bad, ok, transactions[3].hash]);
  const rev = transactions[1];
  assert.equal(rev.receipt.status, '0x0'); assert.match(rev.error, /revert/i); assert.match(rev.revertData, /^0x[0-9a-f]{8}/, 'the custom error selector + args');
  assert.equal(transactions[2].receipt.logs.length, 1, 'the Transfer event rides along');
  const blk = await t.rpc('eth_getBlockByNumber', [transactions[2].receipt.blockNumber, false]);
  assert.equal(transactions[2].timestamp, blk.timestamp); assert.ok(Number(BigInt(blk.timestamp)) > GENESIS_TS, 'the block timestamp rides along');
  assert.equal(transactions[0].error.length > 0, true); assert.equal(transactions[0].revertData, null);
  assert.equal(transactions[3].to, null); assert.equal(transactions[3].receipt.contractAddress, pepe);
  // the same over RPC, paged
  const page = await t.rpc('terrarium_transactions', [{ limit: 2 }]);
  assert.equal(page.total, 4); assert.deepEqual(page.transactions.map((x) => x.hash), [dropped, bad]);
  const next = await t.rpc('terrarium_transactions', [{ limit: 2, before: bad }]);
  assert.deepEqual(next.transactions.map((x) => x.status), ['success', 'success']);
  // pending shows up first while interval mining
  await t.rpc('evm_setIntervalMining', [60_000]);
  const pend = await t.wallet(me).sendTransaction({ to: other, value: 1n });
  assert.equal(t.sim.transactions().transactions[0].status, 'pending'); assert.equal(t.sim.transactions().transactions[0].hash, pend);
  await t.rpc('evm_setAutomine', [true]); await t.rpc('evm_mine');
  // persisted: a fresh engine restoring the dump lists the same statuses and revert data
  await t.sim.flush();
  const t2 = await boot({ persist: { storage, key: 'x' } });
  const again = t2.sim.transactions().transactions;
  assert.deepEqual(again.map((x) => x.status), ['success', 'dropped', 'reverted', 'success', 'success']);
  assert.equal(again[2].revertData, rev.revertData);
  t.sim.stop(); t2.sim.stop();
});

test('runtime: terrarium_transactions decodes calls, events and custom errors with `abis`, names addresses with `labels`', async () => {
  const sim = await runScenario({ chainId: 31337, persist: false, clock: 1_700_000_000, abis: [PEPE.abi],
    labels: (ctx) => ({ [ctx.state.pepe]: 'PEPE', [ctx.accounts[1]]: 'Alice' }),
    async setup(ctx) {
      const me = ctx.wallet(ctx.accounts[0]);
      const r = await ctx.wait(me.deployContract({ abi: PEPE.abi, bytecode: PEPE.bytecode, args: [parseEther('10')] }));
      ctx.state.pepe = r.contractAddress;
      await ctx.wait(me.writeContract({ address: r.contractAddress, abi: PEPE.abi, functionName: 'transfer', args: [ctx.accounts[1], parseEther('3')] }));
      // Alice sends more than she has: reverts with InsufficientBalance(requested, available)
      await ctx.wait(ctx.wallet(ctx.accounts[1]).writeContract({ address: r.contractAddress, abi: PEPE.abi, functionName: 'transfer', args: [ctx.accounts[0], parseEther('5')], gas: 100000n }));
      // a call the ABIs do not know: raw selector shown
      await ctx.wait(ctx.sim.sendAs(ctx.accounts[2], { to: r.contractAddress, data: '0xdeadbeef', gas: '0x186a0' }));
    } });
  const { total, labels, transactions: [unknown, reverted, transfer, deploy] } = await sim.provider.request({ method: 'terrarium_transactions', params: [{}] });
  assert.equal(total, 4);
  assert.equal(labels[sim.accounts[1].address.toLowerCase()], 'Alice'); assert.equal(labels[sim.accounts[0].address.toLowerCase()], 'Account #0'); assert.equal(labels[transfer.to.toLowerCase()], 'PEPE');
  assert.deepEqual(deploy.method, { name: 'create', args: [] });
  assert.equal(transfer.method.name, 'transfer'); assert.deepEqual(transfer.method.args, [sim.accounts[1].address, parseEther('3').toString()]);
  assert.equal(transfer.logs[0].decoded.name, 'Transfer'); assert.deepEqual(transfer.logs[0].decoded.args, { from: sim.accounts[0].address, to: sim.accounts[1].address, value: parseEther('3').toString() });
  assert.equal(reverted.status, 'reverted'); assert.deepEqual(reverted.revert, { name: 'InsufficientBalance', args: [parseEther('5').toString(), parseEther('3').toString()] });
  assert.equal(reverted.logs.length, 0);
  assert.deepEqual(unknown.method, { name: null, selector: '0xdeadbeef' }); assert.equal(unknown.status, 'reverted'); assert.equal(unknown.revert, null, 'empty revert data: nothing to decode');
  sim.stop();
});
