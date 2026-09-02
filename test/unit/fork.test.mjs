// Fork mode: offline replay of a recorded mainnet fixture, misses, the fork's block numbering, and online recording
// against a local fake node (no network in any test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseAbi, encodeFunctionData, keccak256, pad } from 'viem';
import { createTerrarium, OfflineStateError } from 'terrarium/engine';
import { boot, FIXTURE, rejects } from './helpers.mjs';

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address, uint256) returns (bool)']);
const noNetwork = () => { const real = globalThis.fetch; let attempts = 0; globalThis.fetch = async (url) => { attempts++; throw new Error(`offline: ${url}`); }; return { restore: () => { globalThis.fetch = real; }, get attempts() { return attempts; } }; };

test('offline fixture: the recorded state answers, the head is fork block + recorded blocks, nothing is fetched', async () => {
  const net = noNetwork();
  try {
    const t = await boot({ chainId: 1, fork: { blockNumber: FIXTURE.blockNumber, offline: true }, restore: FIXTURE.dump });
    const { WETH, USDC, user } = FIXTURE.addresses;
    assert.equal(t.sim.blockNumber, BigInt(FIXTURE.blockNumber) + 3n, 'genesis at fork + 1, then approve + swap');
    assert.equal(await t.rpc('eth_getBlockByNumber', ['0x' + FIXTURE.blockNumber.toString(16), false]), null, 'blocks before the fork are not served');
    assert.equal(await t.pub.readContract({ address: WETH, abi: erc20, functionName: 'balanceOf', args: [user] }), BigInt(FIXTURE.expected.received));
    const hash = await t.wallet(user).writeContract({ address: USDC, abi: erc20, functionName: 'transfer', args: [user, 1_000_000n] });   // to self: only the recorded balance slot is touched
    assert.equal((await t.pub.waitForTransactionReceipt({ hash })).status, 'success', 'a new tx on the real USDC proxy, offline');
    assert.match((await t.rpc('eth_getBlockByNumber', ['latest', false])).stateRoot, /^0x0{64}$/, 'no local trie in fork mode: placeholder root');
    assert.deepEqual(t.sim.offlineMisses, []); assert.equal(net.attempts, 0);
  } finally { net.restore(); }
});

test('a read the fixture cannot answer is an OfflineStateError and shows up in offlineMisses', async () => {
  const net = noNetwork();
  try {
    const t = await boot({ chainId: 1, fork: { blockNumber: FIXTURE.blockNumber, offline: true }, restore: FIXTURE.dump });
    const unknown = '0x00000000000000000000000000000000000000E5';
    await rejects(t.rpc('eth_getBalance', [unknown, 'latest']), (e) => { assert.ok(e instanceof OfflineStateError); assert.match(e.message, /not in the fixture/); });
    assert.deepEqual(t.sim.offlineMisses.map((m) => m.kind), ['account']);
    await rejects(t.rpc('eth_call', [{ to: unknown, data: encodeFunctionData({ abi: erc20, functionName: 'balanceOf', args: [unknown] }) }, 'latest']), (e) => assert.ok(e instanceof OfflineStateError));
    assert.ok(t.sim.offlineMisses.length >= 2); assert.equal(net.attempts, 0);
  } finally { net.restore(); }
});

test('online fork against a fake node: lazy reads are fetched once, recorded, and the dump replays offline', async () => {
  const token = '0x00000000000000000000000000000000000000aa', holder = '0x00000000000000000000000000000000000000bb';   // lowercase: compared against what the state manager sends
  // a "contract" whose code returns storage slot 0 for any call: PUSH0 SLOAD PUSH0 MSTORE PUSH1 32 PUSH0 RETURN
  const code = '0x5f545f5260205ff3';
  const calls = [];
  const server = createServer((req, res) => { let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    const { id, method, params } = JSON.parse(body); calls.push(method);
    const result = method === 'eth_getProof' ? { nonce: params[0].toLowerCase() === token ? '0x1' : '0x0', balance: '0x0', codeHash: params[0].toLowerCase() === token ? keccak256(code) : '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', storageHash: '0x' + '0'.repeat(64), accountProof: [], storageProof: [] }
      : method === 'eth_getCode' ? (params[0].toLowerCase() === token ? code : '0x')
      : method === 'eth_getStorageAt' ? (params[0].toLowerCase() === token && params[1] === '0x' + '0'.repeat(64) ? pad('0x2a', { size: 32 }) : '0x' + '0'.repeat(64))
      : method === 'eth_getBlockByNumber' ? { number: params[0], timestamp: '0x1', hash: '0x' + '11'.repeat(32), stateRoot: '0x' + '0'.repeat(64), gasLimit: '0x1c9c380', baseFeePerGas: '0x1' }
      : null;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, result })); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const t = await boot({ chainId: 1, fork: { url, blockNumber: 100 } });
    assert.equal(t.sim.blockNumber, 101n);
    const value = await t.rpc('eth_call', [{ to: token, data: '0x' }, 'latest']);
    assert.equal(BigInt(value), 42n, 'executed the remote code against remote storage');
    assert.equal(BigInt(await t.rpc('eth_call', [{ to: token, data: '0x' }, 'latest'])), 42n);
    const fetched = calls.length;
    await t.rpc('eth_call', [{ to: token, data: '0x' }, 'latest']);
    assert.equal(calls.length, fetched, 'cached after the first fetch');
    assert.equal(await t.rpc('eth_getBalance', [holder, 'latest']), '0x0');
    const dump = await t.sim.dumpState();
    assert.ok(dump.remote.code[token] || dump.remote.code[token.toLowerCase()] || Object.keys(dump.remote.code).some((k) => k.toLowerCase() === token), 'the code was recorded');
    assert.ok(Object.keys(dump.remote.storage).length >= 1); assert.ok(Object.keys(dump.remote.accounts).length >= 2);
    const net = noNetwork();
    try {
      const off = await boot({ chainId: 1, fork: { blockNumber: 100, offline: true }, restore: dump });
      assert.equal(BigInt(await off.rpc('eth_call', [{ to: token, data: '0x' }, 'latest'])), 42n);
      assert.equal(await off.rpc('eth_getBalance', [holder, 'latest']), '0x0');
      assert.deepEqual(off.sim.offlineMisses, []); assert.equal(net.attempts, 0);
    } finally { net.restore(); }
  } finally { server.close(); }
});
