// The CLI: fetch-code against a local fake node, usage errors, and the standalone build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, statSync } from 'node:fs';
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
});

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
