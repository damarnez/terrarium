// Transactions: signing, impersonation, raw txs, reverts with decodable data, gas estimation, eth_call overrides,
// and what happens to a transaction a node would drop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, getContractAddress, keccak256, parseEther, decodeErrorResult } from 'viem';
import { boot, deployPepe, PEPE, rejects } from './helpers.mjs';

test('deploy + call + transfer through viem: deterministic address, receipt, logs, nonce', async () => {
  const t = await boot();
  const treasury = t.accounts[9];
  const pepe = await deployPepe(t);
  assert.equal(pepe.toLowerCase(), getContractAddress({ from: treasury, nonce: 0n }).toLowerCase());
  assert.notEqual(await t.rpc('eth_getCode', [pepe, 'latest']), '0x');
  assert.equal(await t.rpc('eth_getTransactionCount', [treasury, 'latest']), '0x1');
  const bal = (who) => t.pub.readContract({ address: pepe, abi: PEPE.abi, functionName: 'balanceOf', args: [who] });
  assert.equal(await bal(treasury), parseEther('1000000'));
  const hash = await t.wallet(treasury).writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [t.accounts[0], parseEther('5')] });
  const r = await t.pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, 'success'); assert.equal(r.logs.length, 1); assert.equal(r.logs[0].address.toLowerCase(), pepe.toLowerCase());
  assert.equal(await bal(t.accounts[0]), parseEther('5'));
  assert.equal(await t.rpc('eth_getTransactionCount', [treasury, 'latest']), '0x2');
});

test('reverts reach viem as decodable custom errors, from eth_estimateGas and from eth_call', async () => {
  const t = await boot();
  const pepe = await deployPepe(t);
  const poor = t.accounts[3];
  const e = await rejects(t.wallet(poor).writeContract({ address: pepe, abi: PEPE.abi, functionName: 'transfer', args: [t.accounts[0], 1n] }), (e) => {
    assert.ok(e instanceof BaseError, 'a viem BaseError, not a foreign error viem would retry');
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    assert.equal(rev.data.errorName, 'InsufficientBalance');
    assert.deepEqual(rev.data.args, [1n, 0n]);
  });
  assert.ok(e);
  // the raw RPC error: code 3 + revert data, Anvil-style
  await rejects(t.rpc('eth_call', [{ from: poor, to: pepe, data: encodeFunctionData({ abi: PEPE.abi, functionName: 'transfer', args: [t.accounts[0], 1n] }) }, 'latest']), (e) => {
    assert.equal(e.code, 3); assert.equal(e.details, 'execution reverted');
    assert.equal(decodeErrorResult({ abi: PEPE.abi, data: e.data }).errorName, 'InsufficientBalance');
  });
  // a tx forced on-chain with an explicit gas limit gets a failed receipt, like a real node
  const hash = await t.rpc('eth_sendTransaction', [{ from: poor, to: pepe, gas: '0x30000', data: encodeFunctionData({ abi: PEPE.abi, functionName: 'transfer', args: [t.accounts[0], 1n] }) }]);
  const r = await t.pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, 'reverted'); assert.ok(r.gasUsed > 21000n);
});

test('gas estimation: geth-style exact estimates cover the real cost; fast mode uses the block gas limit', async () => {
  const exact = await boot();
  const pepe = await deployPepe(exact);
  const call = { from: exact.accounts[9], to: pepe, data: encodeFunctionData({ abi: PEPE.abi, functionName: 'transfer', args: [exact.accounts[0], 1n] }) };
  const est = BigInt(await exact.rpc('eth_estimateGas', [call]));
  const hash = await exact.rpc('eth_sendTransaction', [call]);
  const r = await exact.rpc('eth_getTransactionReceipt', [hash]);
  assert.ok(est >= BigInt(r.gasUsed) && est < BigInt(r.gasUsed) + 5000n, `estimate ${est} vs used ${r.gasUsed}`);
  assert.equal(BigInt((await exact.rpc('eth_getTransactionByHash', [hash])).gas), est);
  const fast = await boot({ gasEstimation: 'fast' });
  const pepe2 = await deployPepe(fast);
  const h2 = await fast.rpc('eth_sendTransaction', [{ ...call, to: pepe2 }]);
  assert.equal((await fast.rpc('eth_getTransactionByHash', [h2])).gas, '0x1c9c380');
});

test('eth_call: state overrides, the pending tag, calls to empty addresses; nothing sticks', async () => {
  const t = await boot();
  const pepe = await deployPepe(t);
  const data = encodeFunctionData({ abi: PEPE.abi, functionName: 'balanceOf', args: [t.accounts[0]] });
  const slot = t.sim.slotFromLayout(PEPE.storageLayout, ['balanceOf', t.accounts[0]]);
  const overridden = await t.rpc('eth_call', [{ to: pepe, data }, 'latest', { [pepe]: { stateDiff: { [slot]: '0x' + (42n).toString(16).padStart(64, '0') } } }]);
  assert.equal(BigInt(overridden), 42n);
  assert.equal(BigInt(await t.rpc('eth_call', [{ to: pepe, data }, 'latest'])), 0n, 'the override did not persist');
  assert.equal(BigInt(await t.rpc('eth_call', [{ to: pepe, data }, 'pending'])), 0n);
  assert.equal(await t.rpc('eth_call', [{ to: t.accounts[5], data: '0x1234' }, 'latest']), '0x');
  const withCode = await t.rpc('eth_call', [{ to: t.accounts[5], data }, 'latest', { [t.accounts[5]]: { code: PEPE.deployedBytecode } }]);
  assert.equal(BigInt(withCode), 0n, 'code override runs the bytecode at an empty address');
});

test('impersonation: sendAs from any address, anvil_impersonateAccount, impersonateAll, and the error without it', async () => {
  const t = await boot();
  const stranger = '0x00000000000000000000000000000000000000A1';
  await rejects(t.rpc('eth_sendTransaction', [{ from: stranger, to: t.accounts[0], value: '0x0' }]), (e) => { assert.equal(e.code, -32000); assert.match(e.message, /no key for/); });
  await t.rpc('anvil_setBalance', [stranger, '0x' + parseEther('1').toString(16)]);
  const hash = await t.sim.sendAs(stranger, { to: t.accounts[0], value: '0x' + parseEther('0.5').toString(16) });
  const r = await t.rpc('eth_getTransactionReceipt', [hash]);
  assert.equal(r.status, '0x1'); assert.equal(r.from.toLowerCase(), stranger.toLowerCase());
  const tx = await t.rpc('eth_getTransactionByHash', [hash]);
  assert.equal(BigInt(tx.r), BigInt(stranger), 'Anvil-style fake signature: r encodes the sender');
  await t.rpc('anvil_stopImpersonatingAccount', [stranger]);
  await rejects(t.rpc('eth_sendTransaction', [{ from: stranger, to: t.accounts[0], value: '0x0' }]), (e) => assert.equal(e.code, -32000));
  const all = await boot({ impersonateAll: true });
  await all.rpc('anvil_setBalance', [stranger, '0x' + parseEther('1').toString(16)]);
  assert.equal((await all.rpc('eth_getTransactionReceipt', [await all.rpc('eth_sendTransaction', [{ from: stranger, to: all.accounts[0], value: '0x1' }])])).status, '0x1');
});

test('raw transactions: a viem-signed tx is accepted, hashed like a node would, and a wrong nonce yields a failed receipt instead of a hang', async () => {
  const t = await boot();
  const acct = t.sim.accounts[0];
  const good = await acct.signTransaction({ chainId: 31337, type: 'eip1559', nonce: 0, to: t.accounts[1], value: 1n, gas: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n });
  const hash = await t.rpc('eth_sendRawTransaction', [good]);
  assert.equal(hash, keccak256(good));
  assert.equal((await t.rpc('eth_getTransactionReceipt', [hash])).status, '0x1');
  const bad = await acct.signTransaction({ chainId: 31337, type: 'eip1559', nonce: 7, to: t.accounts[1], value: 1n, gas: 21000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1n });
  const h2 = await t.rpc('eth_sendRawTransaction', [bad]);
  const r = await t.pub.waitForTransactionReceipt({ hash: h2 });
  assert.equal(r.status, 'reverted'); assert.equal(r.gasUsed, 0n);
  assert.match((await t.rpc('eth_getTransactionReceipt', [h2])).droppedReason, /nonce/i);
});

test('an impersonated sender without funds: dropped at mining, with the reason on the receipt', async () => {
  const t = await boot();
  const broke = '0x00000000000000000000000000000000000000B2';
  const hash = await t.sim.sendAs(broke, { to: t.accounts[0], value: '0x1' });
  const r = await t.rpc('eth_getTransactionReceipt', [hash]);
  assert.equal(r.status, '0x0'); assert.match(r.droppedReason, /fund|balance/i);
  assert.equal(await t.rpc('eth_blockNumber'), '0x1', 'the block was still mined');
});
