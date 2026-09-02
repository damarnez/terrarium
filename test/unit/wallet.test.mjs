// The wallet side: accounts, signing, chain switching, realism knobs, the node provider, extension methods, errors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseError, verifyMessage, verifyTypedData, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createTerrarium, TEST_KEYS } from 'terrarium/engine';
import { boot, rejects, sleep } from './helpers.mjs';

test('accounts: the ten Anvil keys by default, any keys you pass, each funded', async () => {
  const t = await boot();
  assert.equal(TEST_KEYS.length, 10);
  assert.deepEqual(await t.rpc('eth_accounts'), TEST_KEYS.map((k) => privateKeyToAccount(k).address));
  assert.equal(t.accounts[0], '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  assert.deepEqual(await t.rpc('eth_requestAccounts'), t.accounts);
  const one = await createTerrarium({ keys: [TEST_KEYS[3]], clock: () => 1 });
  assert.deepEqual(await one.provider.request({ method: 'eth_accounts' }), [privateKeyToAccount(TEST_KEYS[3]).address]);
  assert.equal(await one.provider.request({ method: 'eth_getBalance', params: [one.accounts[0].address, 'latest'] }), '0x' + parseEther('10000').toString(16));
});

test('personal_sign and eth_signTypedData_v4 produce verifiable signatures; unknown signers get 4100', async () => {
  const t = await boot();
  const sig = await t.rpc('personal_sign', ['0x68656c6c6f', t.accounts[0]]);
  assert.ok(await verifyMessage({ address: t.accounts[0], message: { raw: '0x68656c6c6f' }, signature: sig }));
  const typed = { domain: { name: 'T', version: '1', chainId: 31337 }, types: { Mail: [{ name: 'to', type: 'address' }] }, primaryType: 'Mail', message: { to: t.accounts[1] } };
  const sig2 = await t.rpc('eth_signTypedData_v4', [t.accounts[0], JSON.stringify(typed)]);
  assert.ok(await verifyTypedData({ address: t.accounts[0], ...typed, signature: sig2 }));
  assert.equal(await t.rpc('eth_signTypedData_v4', [t.accounts[0], typed]), sig2, 'object or string');
  await rejects(t.rpc('personal_sign', ['0x00', '0x00000000000000000000000000000000000000D4']), (e) => assert.equal(e.code, 4100));
});

test('wallet_* methods: the configured chain only, permissions shaped like MetaMask', async () => {
  const t = await boot({ chainId: 10 });
  assert.equal(await t.rpc('wallet_switchEthereumChain', [{ chainId: '0xa' }]), null);
  await rejects(t.rpc('wallet_switchEthereumChain', [{ chainId: '0x1' }]), (e) => assert.equal(e.code, 4902));
  assert.equal(await t.rpc('wallet_addEthereumChain', [{ chainId: '0x1' }]), null);
  assert.deepEqual(await t.rpc('wallet_requestPermissions', [{ eth_accounts: {} }]), [{ parentCapability: 'eth_accounts' }]);
  assert.deepEqual(await t.rpc('wallet_getPermissions'), [{ parentCapability: 'eth_accounts' }]);
  assert.equal(await t.rpc('wallet_revokePermissions', [{ eth_accounts: {} }]), null);
});

test('rejectNext: the next N signatures fail with 4001, reads are unaffected, the counter is visible', async () => {
  const t = await boot();
  assert.deepEqual(await t.rpc('terrarium_setWallet', [{ rejectNext: 2 }]), { rejectNext: 2, latencyMs: 0, receiptLagMs: 0 });
  assert.equal(await t.rpc('eth_blockNumber'), '0x0', 'reads pass');
  const send = () => t.rpc('eth_sendTransaction', [{ from: t.accounts[0], to: t.accounts[1], value: '0x1' }]);
  await rejects(send(), (e) => { assert.equal(e.code, 4001); assert.ok(e instanceof BaseError); });
  assert.equal((await t.rpc('terrarium_getWallet')).rejectNext, 1);
  await rejects(t.rpc('personal_sign', ['0x00', t.accounts[0]]), (e) => assert.equal(e.code, 4001));
  assert.match(await send(), /^0x[0-9a-f]{64}$/);
  assert.equal(t.sim.wallet.rejectNext, 0);
});

test('latencyMs delays wallet methods only; receiptLagMs hides receipts for a while; initial knobs from options', async () => {
  const t = await boot({ wallet: { latencyMs: 120, receiptLagMs: 150 } });
  assert.deepEqual(await t.rpc('terrarium_getWallet'), { rejectNext: 0, latencyMs: 120, receiptLagMs: 150 });
  let t0 = Date.now(); await t.rpc('eth_blockNumber'); assert.ok(Date.now() - t0 < 60, 'node reads are instant');
  t0 = Date.now(); const hash = await t.rpc('eth_sendTransaction', [{ from: t.accounts[0], to: t.accounts[1], value: '0x1' }]); assert.ok(Date.now() - t0 >= 120);
  assert.equal(await t.rpc('eth_getTransactionReceipt', [hash]), null, 'mined, but the node has not caught up');
  await sleep(170);
  assert.equal((await t.rpc('eth_getTransactionReceipt', [hash])).status, '0x1');
  await t.rpc('terrarium_setWallet', [{ latencyMs: 0, receiptLagMs: 0 }]);
  const h2 = await t.rpc('eth_sendTransaction', [{ from: t.accounts[0], to: t.accounts[1], value: '0x1' }]);
  assert.equal((await t.pub.waitForTransactionReceipt({ hash: h2 })).status, 'success');
});

test('sim.node is the same chain as a node: no accounts, no signing, reads and extensions work', async () => {
  const t = await boot({ methods: { terrarium_ping: (x) => `pong ${x}` } });
  const node = (method, params = []) => t.sim.node.request({ method, params });
  assert.deepEqual(await node('eth_accounts'), []);
  await rejects(node('eth_sendTransaction', [{ from: t.accounts[0], to: t.accounts[1] }]), (e) => { assert.equal(e.code, 4100); assert.match(e.message, /node, not a wallet/); });
  await rejects(node('personal_sign', ['0x00', t.accounts[0]]), (e) => assert.equal(e.code, 4100));
  await t.rpc('evm_mine');
  assert.equal(await node('eth_blockNumber'), '0x1');
  assert.equal(await node('terrarium_ping', [1]), 'pong 1');
  assert.equal(await t.rpc('terrarium_ping', [2]), 'pong 2');
});

test('extension methods run outside the lock and may call back into the chain; unknown methods are -32601', async () => {
  const t = await boot();
  t.sim.addMethod('terrarium_mineTwo', async () => { await t.rpc('evm_mine'); await t.rpc('evm_mine'); return t.rpc('eth_blockNumber'); });
  assert.equal(await t.rpc('terrarium_mineTwo'), '0x2');
  await rejects(t.rpc('eth_whatever'), (e) => { assert.equal(e.code, -32601); assert.ok(e instanceof BaseError); });
  assert.throws(() => { throw Object.assign(new Error('x'), { code: 1 }); });
});

test('announce(): an EIP-6963 wallet named Terrarium Wallet, re-announced on request', async () => {
  const t = await boot();
  const win = new EventTarget(); const seen = [];
  win.addEventListener('eip6963:announceProvider', (e) => seen.push(e.detail));
  t.sim.announce(win);
  assert.equal(seen.length, 1); assert.equal(seen[0].info.rdns, 'dev.terrarium'); assert.equal(seen[0].info.name, 'Terrarium Wallet'); assert.equal(seen[0].provider, t.sim.provider);
  win.dispatchEvent(new Event('eip6963:requestProvider'));
  assert.equal(seen.length, 2);
  assert.equal(t.sim.announce(undefined), undefined, 'no window: no-op');
});
