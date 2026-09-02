// Smoke test for the WASM engine in Node: deploy PEPE and call balanceOf, with an in-memory JS host.
import { readFileSync } from 'node:fs';
import { keccak256, encodeFunctionData, decodeFunctionResult, getContractAddress, numberToHex } from 'viem';
import init, { run, version } from './pkg/terrarium_evm.js';
await init({ module_or_path: readFileSync(new URL('./pkg/terrarium_evm_bg.wasm', import.meta.url)) });
const PEPE = JSON.parse(readFileSync(new URL('../../contracts/out/PEPE.json', import.meta.url), 'utf8'));
const state = new Map();   // address(lower) -> { balance, nonce, code, storage: Map }
const acct = (a) => state.get(a.toLowerCase());
const user = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
state.set(user, { balance: 10n ** 22n, nonce: 0n, code: '0x', storage: new Map() });
const host = {
  account: (a) => { const x = acct(a); return x ? { balance: numberToHex(x.balance), nonce: numberToHex(x.nonce), codeHash: keccak256(x.code), code: x.code } : null; },
  storage: (a, slot) => acct(a)?.storage.get(slot.toLowerCase()) ?? '0x' + '0'.repeat(64),
  blockHash: (n) => '0x' + '11'.repeat(32),
};
const apply = (r) => { for (const c of r.state) { if (c.deleted) { state.delete(c.address.toLowerCase()); continue; } const cur = acct(c.address) ?? { balance: 0n, nonce: 0n, code: '0x', storage: new Map() }; cur.balance = BigInt(c.balance); cur.nonce = BigInt(c.nonce); if (c.code) cur.code = c.code; for (const [k, v] of c.storage) cur.storage.set(k.toLowerCase(), v); state.set(c.address.toLowerCase(), cur); } };
const block = { number: '0x1', timestamp: '0x6a980000', gasLimit: numberToHex(30_000_000n), baseFee: numberToHex(10n ** 9n) };
const cfg = { chainId: 31337, spec: 'cancun' };
console.log(version());
const t0 = performance.now();
const deploy = JSON.parse(run(host, JSON.stringify({ tx: { from: user, to: null, value: '0x0', data: PEPE.bytecode + '000000000000000000000000000000000000000000000000000000000000002a', gasLimit: numberToHex(3_000_000n), gasPrice: numberToHex(2n * 10n ** 9n), priorityFee: '0x1', nonce: '0x0' }, block, cfg })));
apply(deploy);
const pepe = deploy.created;
const call = JSON.parse(run(host, JSON.stringify({ tx: { from: user, to: pepe, value: '0x0', data: encodeFunctionData({ abi: PEPE.abi, functionName: 'balanceOf', args: [user] }), gasLimit: numberToHex(1_000_000n), gasPrice: '0x0', nonce: '0x1' }, block, cfg: { ...cfg, skipBalance: true, noBaseFee: true, traceSloads: true } })));
const bal = decodeFunctionResult({ abi: PEPE.abi, functionName: 'balanceOf', data: call.output });
console.log({ deployOk: deploy.success, gasUsed: deploy.gasUsed, created: pepe, expectedAddress: getContractAddress({ from: user, nonce: 0n }), codeBytes: (acct(pepe).code.length - 2) / 2, deployLogs: deploy.logs.length, balanceOf: bal.toString(), sloads: call.sloads, ms: Math.round(performance.now() - t0) });
if (!(deploy.success && bal === 42n && call.sloads.length >= 1 && pepe.toLowerCase() === getContractAddress({ from: user, nonce: 0n }).toLowerCase())) { console.log('FAIL'); process.exit(1); }
console.log('PASS');
