// The CLI: fetch-code and record against a local fake node, usage errors, and the standalone build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { keccak256, pad } from 'viem';
import { createTerrarium } from 'terrarium/engine';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = new URL('../../packages/terrarium/bin/terrarium.mjs', import.meta.url).pathname;
const root = new URL('../../', import.meta.url).pathname;
const run = (args, cwd = root) => spawnSync('node', [cli, ...args], { cwd, encoding: 'utf8' });
/** async, for tests that also host a fake node in this process (a sync spawn would deadlock it) */
const runAsync = (args) => promisify(execFile)('node', [cli, ...args], { cwd: root, encoding: 'utf8' }).then((r) => ({ status: 0, ...r }), (e) => ({ status: e.code, stdout: e.stdout, stderr: e.stderr }));

test('usage: no command exits 0, unknown command or missing --rpc exit 1', () => {
  assert.equal(run([]).status, 0); assert.match(run([]).stdout, /usage/);
  assert.equal(run(['frobnicate']).status, 1);
  const r = run(['fetch-code', 'x=0x1']); assert.equal(r.status, 1); assert.match(r.stderr, /usage/);
  const rec = run(['record', 'x=0x1']); assert.equal(rec.status, 1); assert.match(rec.stderr, /usage/);
});

const EMPTY_CODE_HASH = '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470';
/** a fake node: one "contract" at TOKEN whose code returns storage slot 0 (42) for any call; everything else is empty */
const TOKEN = '0x00000000000000000000000000000000000000aa', TOKEN_CODE = '0x5f545f5260205ff3';
async function fakeNode(chainId = '0x1') {
  const calls = [];
  const server = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const { id, method, params } = JSON.parse(b); calls.push({ method, params });
    const isToken = typeof params?.[0] === 'string' && params[0].toLowerCase() === TOKEN;
    const result = method === 'eth_chainId' ? chainId : method === 'eth_blockNumber' ? '0x64'
      : method === 'eth_getCode' ? (isToken ? TOKEN_CODE : '0x')
      : method === 'eth_getProof' ? { nonce: isToken ? '0x1' : '0x0', balance: isToken ? '0x0' : '0xde0b6b3a7640000', codeHash: isToken ? keccak256(TOKEN_CODE) : EMPTY_CODE_HASH, storageHash: '0x' + '0'.repeat(64), accountProof: [], storageProof: [] }
      : method === 'eth_getStorageAt' ? (isToken && BigInt(params[1]) === 0n ? pad('0x2a', { size: 32 }) : '0x' + '0'.repeat(64))
      : method === 'eth_getBlockByNumber' ? (BigInt(params[0]) <= 100n ? { number: params[0], timestamp: '0x65000000', hash: '0x' + '11'.repeat(32), stateRoot: '0x' + '0'.repeat(64), gasLimit: '0x1c9c380', baseFeePerGas: '0x1' } : null)
      : null;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, result })); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { rpc: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() };
}

test('fetch-code writes a fixture with the runtime code of each named address and refuses empty addresses', async () => {
  const server = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const { id, method, params } = JSON.parse(b);
    const result = method === 'eth_blockNumber' ? '0x64' : method === 'eth_getCode' ? (params[0].endsWith('aa') ? '0x6001600155' : '0x') : null;
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result })); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const rpc = `http://127.0.0.1:${server.address().port}`;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'terrarium-cli-')); const out = join(dir, 'f.json');
    const ok = await runAsync(['fetch-code', 'thing=0x00000000000000000000000000000000000000aa', '--rpc', rpc, '--out', out]);
    assert.equal(ok.status, 0, ok.stderr);
    const f = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(f.blockNumber, 100); assert.deepEqual(f.contracts, { thing: { address: '0x00000000000000000000000000000000000000aa', code: '0x6001600155' } }); assert.match(f.source, /fetch-code/);
    const bad = await runAsync(['fetch-code', 'ghost=0x00000000000000000000000000000000000000bb', '--rpc', rpc, '--out', join(dir, 'g.json')]);
    assert.equal(bad.status, 1); assert.match(bad.stderr, /no code at/);
  } finally { server.close(); }
});

test('fetch-code --block pins the block the code is read at and records the chain id; --chain must match the node', async () => {
  const node = await fakeNode('0x2105');   // Base
  try {
    const dir = mkdtempSync(join(tmpdir(), 'terrarium-cli-')); const out = join(dir, 'f.json');
    const ok = await runAsync(['fetch-code', `token=${TOKEN}`, '--rpc', node.rpc, '--block', '80', '--chain', '8453', '--out', out]);
    assert.equal(ok.status, 0, ok.stderr);
    const f = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(f.chainId, 8453); assert.equal(f.blockNumber, 80); assert.equal(f.contracts.token.code, TOKEN_CODE);
    assert.deepEqual(node.calls.find((c) => c.method === 'eth_getCode').params, [TOKEN, '0x50'], 'code read at the requested block, not latest');
    const wrong = await runAsync(['fetch-code', `token=${TOKEN}`, '--rpc', node.rpc, '--chain', '1', '--out', join(dir, 'g.json')]);
    assert.equal(wrong.status, 1); assert.match(wrong.stderr, /--chain 1 but .* serves chain 8453/);
  } finally { node.close(); }
});

test('record: the state of a chain at a block as an offline fixture; the script is recorded and rolled back, --keep keeps it', { timeout: 120_000 }, async () => {
  const node = await fakeNode();
  const dir = mkdtempSync(join(tmpdir(), 'terrarium-cli-')); const out = join(dir, 'fork.json'), script = join(dir, 'warm.mjs');
  writeFileSync(script, `export default async ({ sim, pub, accounts, addresses, rpc }) => {
    const value = await rpc('eth_call', [{ to: addresses.token, data: '0x' }, 'latest']);   // touches the token's code + slot 0: recorded
    await rpc('evm_mine');                                                                    // a local block: rolled back unless --keep
    return { value, user: accounts[0], head: Number(await pub.getBlockNumber()) };
  };\n`);
  try {
    const r = await runAsync(['record', `token=${TOKEN}`, '--rpc', node.rpc, '--block', '100', '--chain', '1', '--storage', 'token:0x0,0x1', '--script', script, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /forking chain 1 at block 100/); assert.match(r.stdout, /offline replay OK/);
    const f = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(f.chainId, 1); assert.equal(f.blockNumber, 100); assert.equal(f.timestamp, 0x65000000);
    assert.deepEqual(f.addresses, { token: TOKEN });
    assert.equal(BigInt(f.expected.value), 42n); assert.equal(f.expected.head, 102, 'the script saw its own block');
    assert.equal(f.dump.chain.blocks.length, 1, 'the script\'s block was rolled back: the fixture is block 100 + genesis');
    assert.ok(f.remoteReads.code >= 1 && f.remoteReads.storage >= 2, JSON.stringify(f.remoteReads));
    assert.ok(node.calls.some((c) => c.method === 'eth_getStorageAt' && BigInt(c.params[1]) === 1n), '--storage slot 1 was read');
    // the fixture replays with the network unplugged, in this process
    const realFetch = globalThis.fetch; globalThis.fetch = async (url) => { throw new Error(`offline: ${url}`); };
    try {
      const sim = await createTerrarium({ chainId: 1, fork: { blockNumber: 100, offline: true }, restore: f.dump, seed: 1, clock: () => f.timestamp });
      assert.equal(BigInt(await sim.provider.request({ method: 'eth_call', params: [{ to: TOKEN, data: '0x' }, 'latest'] })), 42n);
      assert.equal(sim.blockNumber, 101n); assert.deepEqual(sim.offlineMisses, []);
    } finally { globalThis.fetch = realFetch; }
    const kept = await runAsync(['record', `token=${TOKEN}`, '--rpc', node.rpc, '--block', '100', '--script', script, '--keep', '--out', join(dir, 'kept.json')]);
    assert.equal(kept.status, 0, kept.stderr);
    assert.equal(JSON.parse(readFileSync(join(dir, 'kept.json'), 'utf8')).dump.chain.blocks.length, 2, '--keep: the script\'s block stays in the fixture');
    const gone = await runAsync(['record', '--rpc', node.rpc, '--block', '500', '--out', join(dir, 'x.json')]);
    assert.equal(gone.status, 1); assert.match(gone.stderr, /block 500 is not available/);
  } finally { node.close(); }
});

test('build: one injectable classic script with the Worker bundle and the wasm embedded', { timeout: 240_000 }, () => {
  const out = mkdtempSync(join(tmpdir(), 'terrarium-build-'));
  const r = run(['build', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /terrarium\.js: \d+ KB/);
  for (const f of ['terrarium.js', 'terrarium.worker.js']) assert.ok(existsSync(join(out, f)), f);
  const js = readFileSync(join(out, 'terrarium.js'), 'utf8');
  assert.ok(js.includes('eip6963:announceProvider'), 'announces the wallet');
  assert.ok(js.includes('terrarium-devbar'), 'carries the dev bar');
  assert.ok(js.includes('data:application/wasm') || js.includes('AGFzbQ'), 'the wasm engine travels inside the script');
  assert.ok(statSync(join(out, 'terrarium.js')).size > 1_000_000);
});
