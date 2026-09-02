// The postMessage bridge between the page and the Worker, with both ends in one process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BaseError } from 'viem';
import { createWorkerProvider, ProviderRpcError, serveProvider } from 'terrarium/bridge';
import { boot, rejects } from './helpers.mjs';

/** a fake Worker: page → worker goes to globalThis.onmessage (what serveProvider installs), worker → page comes back through onmessage */
function fakeWorker() { const w = { onmessage: null, postMessage: (req) => setTimeout(() => globalThis.onmessage({ data: req }), 0) }; globalThis.postMessage = (res) => w.onmessage?.({ data: res }); return w; }

test('requests round-trip, errors keep code and data, events are forwarded, early requests wait for ready', async () => {
  const t = await boot();
  const worker = fakeWorker();
  const provider = createWorkerProvider(worker);
  const early = provider.request({ method: 'eth_chainId' });     // queued: the worker has not said "ready"
  serveProvider(t.sim.provider);
  assert.equal(await early, '0x7a69');
  assert.equal(await provider.request({ method: 'eth_blockNumber' }), '0x0');
  await rejects(provider.request({ method: 'eth_call', params: [{ to: t.accounts[0], data: '0x' }, 'latest', { [t.accounts[0]]: { code: '0x60006000fd' } }] }), (e) => {   // PUSH1 0 PUSH1 0 REVERT
    assert.ok(e instanceof ProviderRpcError && e instanceof BaseError); assert.equal(e.code, 3); assert.equal(e.data, '0x');
  });
  await rejects(provider.request({ method: 'nope' }), (e) => assert.equal(e.code, -32601));
  const heads = []; const fn = (m) => heads.push(m); provider.on('message', fn);
  await provider.request({ method: 'evm_mine' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(heads[0].type, 'eth_subscription');
  provider.removeListener('message', fn); await provider.request({ method: 'evm_mine' }); await new Promise((r) => setTimeout(r, 5));
  assert.equal(heads.length, 1);
});
