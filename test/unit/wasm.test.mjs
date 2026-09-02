// The wasm engine on its own: one transaction per call against a plain JS host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, encodeFunctionData, decodeFunctionResult, decodeErrorResult, getContractAddress, numberToHex } from 'viem';
import init, { run, version } from 'terrarium-evm';
import { PEPE } from './helpers.mjs';

await init({ module_or_path: readFileSync(new URL('../../packages/terrarium-evm/pkg/terrarium_evm_bg.wasm', import.meta.url)) });
const user = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', other = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const block = { number: '0x1', timestamp: '0x6a980000', gasLimit: numberToHex(30_000_000n), baseFee: numberToHex(10n ** 9n) };
const cfg = { chainId: 31337, spec: 'cancun' };
function world() {
  const state = new Map([[user, { balance: 10n ** 22n, nonce: 0n, code: '0x', storage: new Map() }]]);
  const acct = (a) => state.get(a.toLowerCase());
  const host = { account: (a) => { const x = acct(a); return x ? { balance: numberToHex(x.balance), nonce: numberToHex(x.nonce), codeHash: keccak256(x.code), code: x.code } : null; }, storage: (a, slot) => acct(a)?.storage.get(slot.toLowerCase()) ?? '0x' + '0'.repeat(64), blockHash: () => '0x' + '11'.repeat(32) };
  const apply = (r) => { for (const c of r.state) { if (c.deleted) { state.delete(c.address.toLowerCase()); continue; } const cur = acct(c.address) ?? { balance: 0n, nonce: 0n, code: '0x', storage: new Map() }; cur.balance = BigInt(c.balance); cur.nonce = BigInt(c.nonce); if (c.code) cur.code = c.code; for (const [k, v] of c.storage) cur.storage.set(k.toLowerCase(), v); state.set(c.address.toLowerCase(), cur); } };
  const exec = (tx, c = cfg) => { const r = JSON.parse(run(host, JSON.stringify({ tx: { value: '0x0', gasLimit: numberToHex(3_000_000n), gasPrice: numberToHex(2n * 10n ** 9n), priorityFee: '0x1', ...tx }, block, cfg: c }))); apply(r); return r; };
  return { state, host, exec };
}

test('version() and a deploy: address, code, logs, gas', () => {
  assert.match(version(), /\d/);
  const w = world();
  const r = w.exec({ from: user, to: null, data: PEPE.bytecode + (42n).toString(16).padStart(64, '0'), nonce: '0x0' });
  assert.equal(r.success, true); assert.equal(r.created.toLowerCase(), getContractAddress({ from: user, nonce: 0n }).toLowerCase());
  assert.equal(r.logs.length, 1); assert.ok(BigInt(r.gasUsed) > 100_000n);
  assert.equal(w.state.get(user).nonce, 1n);
});

test('calls, SLOAD tracing, a revert with custom error data, and the "invalid" refusal for a bad nonce', () => {
  const w = world();
  const pepe = w.exec({ from: user, to: null, data: PEPE.bytecode + (42n).toString(16).padStart(64, '0'), nonce: '0x0' }).created;
  const call = w.exec({ from: user, to: pepe, data: encodeFunctionData({ abi: PEPE.abi, functionName: 'balanceOf', args: [user] }), nonce: '0x1', gasPrice: '0x0', priorityFee: '0x0' }, { ...cfg, skipBalance: true, noBaseFee: true, traceSloads: true });
  assert.equal(decodeFunctionResult({ abi: PEPE.abi, functionName: 'balanceOf', data: call.output }), 42n);
  assert.equal(call.sloads.length, 1); assert.equal(call.sloads[0][0].toLowerCase(), pepe.toLowerCase());
  const rev = w.exec({ from: user, to: pepe, data: encodeFunctionData({ abi: PEPE.abi, functionName: 'transfer', args: [other, 43n] }), nonce: '0x2' });
  assert.equal(rev.success, false); assert.equal(decodeErrorResult({ abi: PEPE.abi, data: rev.output }).errorName, 'InsufficientBalance');
  assert.throws(() => w.exec({ from: user, to: other, data: '0x', nonce: '0x9' }), /invalid:/);
});

test('a host that cannot answer synchronously makes run() throw "missing"', () => {
  const w = world();
  const host = { ...w.host, storage: () => { throw { missing: true }; } };
  const pepe = w.exec({ from: user, to: null, data: PEPE.bytecode + (1n).toString(16).padStart(64, '0'), nonce: '0x0' }).created;
  assert.throws(() => run(host, JSON.stringify({ tx: { from: user, to: pepe, value: '0x0', data: encodeFunctionData({ abi: PEPE.abi, functionName: 'balanceOf', args: [user] }), gasLimit: '0xf4240', gasPrice: '0x0', nonce: '0x1' }, block, cfg: { ...cfg, skipBalance: true, noBaseFee: true } })), /missing/);
});
