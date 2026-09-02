// engine.js — a self-contained EVM chain that lives inside your frontend.
//
// Real EVM bytecode execution (revm compiled to WebAssembly, package `terrarium-evm`) wrapped in an EIP-1193 provider,
// so viem / wagmi / ethers use it exactly like a wallet + node. State (Merkle trie or lazily forked), blocks sealed with
// real tries and blooms, receipts + logs, filters, Anvil-style cheatcodes, event-reactive "actors", persistence
// (IndexedDB / any getItem-setItem store / fixtures), journal replay, fork mode with offline fixtures, and following a
// live chain's block numbers — all in JavaScript around the wasm engine.

import { SimpleStateManager, RPCStateManager, MerkleStateManager } from '@ethereumjs/statemanager';
import { createBlock, createBlockHeader, genTransactionsTrieRoot, Block } from '@ethereumjs/block';
import { MerklePatriciaTrie } from '@ethereumjs/mpt';
import { RLP } from '@ethereumjs/rlp';
import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import { createFeeMarket1559Tx, createTxFromRLP } from '@ethereumjs/tx';
import { Account, createAddressFromString, createAddressFromPrivateKey, hexToBytes, bytesToHex, KECCAK256_NULL } from '@ethereumjs/util';
import { BaseError as ViemBaseError, keccak256, numberToHex, numberToBytes, hexToBigInt, encodeFunctionData, isAddressEqual, getAddress, pad, concat, concatBytes, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// The 10 Anvil / Hardhat default test keys — every dapp dev already knows these addresses.
export const TEST_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
  '0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97',
  '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
];

const GWEI = 1_000_000_000n;
const hex = (n) => numberToHex(BigInt(n));
const ZERO32 = '0x' + '00'.repeat(32);
const EMPTY_ROOT = '0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421'; // keccak256(RLP(empty))

/** Everything that touches EVM state runs through one queue — overlapping checkpoint/revert pairs
 *  from concurrent requests would otherwise corrupt the state stack (Anvil serializes too). */
function createLock() {
  let tail = Promise.resolve();
  return (fn) => { const p = tail.then(fn, fn); tail = p.catch(() => {}); return p; };
}

/** Fork state manager that records every remote read so a session can be dumped to a fixture and
 *  replayed offline (no RPC, no rate limits, deterministic CI). */
class RecordingRPCStateManager extends RPCStateManager {
  remote = { accounts: new Map(), code: new Map(), storage: new Map() };
  /** offline: a cache miss is a bug in the fixture, not a reason to reach the network — throw a precise error instead */
  offline = false; misses = [];
  miss(kind, key) { this.misses.push({ kind, key }); throw new OfflineStateError(`offline fork: ${kind} ${key} is not in the fixture — record it (warm up that read) or run online`); }
  /** Upstream bug (ethereumjs statemanager 10.1.3): RPCStateManager.commit() only commits the *account* cache,
   *  leaving the code/storage caches one checkpoint deep → a later revert() restores the wrong level.
   *  Commit all three caches, like MerkleStateManager does. */
  async commit() { this._caches.commit(); }
  /** public RPCs rate-limit and hiccup; retry with backoff instead of failing the whole tx */
  async retry(fn) { let last; for (let i = 0; i < 5; i++) { try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 250 * 2 ** i)); } } throw last; }
  /** Reads fetched under a checkpoint (every eth_call) vanish from the cache on revert; remote state at a fixed block never
   *  changes, so the recording is a permanent cache: answer repeats from it instead of fetching again. */
  async getAccount(address) { if (this._caches.account.get(address) === undefined && this.remote.accounts.has(address.toString())) { const a = this.remote.accounts.get(address.toString()) ?? undefined; this._caches.account.put(address, a); return a; } if (this.offline && this._caches.account.get(address) === undefined) this.miss('account', address.toString()); if (globalThis.process?.env?.TERRARIUM_DEBUG && this._caches.account.get(address) === undefined) console.log('[remote] account', address.toString(), new Error().stack.split('\n').slice(2, 7).map((l) => l.trim()).join(' <- ')); const a = await this.retry(() => super.getAccount(address)); this.remote.accounts.set(address.toString(), a ?? null); return a; }
  /** an account the cache knows does not exist has no code and no storage: answer without a round trip (the two engines
   *  ask different questions about such addresses — revm loads the account, ethereumjs the code — and a fixture recorded
   *  with one must serve the other) */
  knownAbsent(address) { const e = this._caches.account.get(address); return e !== undefined && e.accountRLP === undefined; }
  async getCode(address) { if (this.knownAbsent(address)) return new Uint8Array(); if (this._caches.code.get(address) === undefined && this.remote.code.has(address.toString())) { const c = this.remote.code.get(address.toString()); this._caches.code.put(address, c); return c; } if (this.offline && this._caches.code.get(address) === undefined) this.miss('code', address.toString()); const c = await this.retry(() => super.getCode(address)); this.remote.code.set(address.toString(), c); return c; }
  async getStorage(address, key) { if (this.knownAbsent(address) && this._caches.storage.get(address, key) === undefined) return new Uint8Array(); const rk = `${address.toString()}_${bytesToHex(key)}`; if (this._caches.storage.get(address, key) === undefined && this.remote.storage.has(rk)) { const v = this.remote.storage.get(rk); this._caches.storage.put(address, key, v); return v; } if (this.offline && this._caches.storage.get(address, key) === undefined) this.miss('storage', `${address.toString()}:${bytesToHex(key)}`); if (globalThis.process?.env?.TERRARIUM_DEBUG && this._caches.storage.get(address, key) === undefined) console.log('[remote] storage', address.toString(), bytesToHex(key)); const v = await this.retry(() => super.getStorage(address, key)); this.remote.storage.set(`${address.toString()}_${bytesToHex(key)}`, v); return v; }
}

const STATE_CHANGING = new Set(['eth_sendTransaction', 'eth_sendRawTransaction', 'evm_mine', 'anvil_mine', 'hardhat_mine', 'evm_setNextBlockTimestamp', 'anvil_setNextBlockTimestamp', 'evm_increaseTime', 'anvil_increaseTime', 'evm_setAutomine', 'anvil_setAutomine', 'anvil_setBalance', 'hardhat_setBalance', 'anvil_setCode', 'hardhat_setCode', 'anvil_setNonce', 'hardhat_setNonce', 'anvil_setStorageAt', 'hardhat_setStorageAt', 'anvil_impersonateAccount', 'hardhat_impersonateAccount', 'anvil_stopImpersonatingAccount', 'hardhat_stopImpersonatingAccount', 'anvil_setNextBlockBaseFeePerGas', 'hardhat_setNextBlockBaseFeePerGas', 'sim_deal', 'sim_setState']);
const pad32 = (h) => pad(typeof h === 'bigint' ? numberToHex(h, { size: 32 }) : h, { size: 32 });

/** small deterministic PRNG (mulberry32) so scripted actors are reproducible when a seed is given */
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Persister backed by IndexedDB (works in Workers, no 5 MB quota). Same getItem/setItem shape as localStorage, async. */
export function indexedDBStorage(dbName = 'terrarium', storeName = 'kv') {
  const open = () => new Promise((res, rej) => { const r = indexedDB.open(dbName, 1); r.onupgradeneeded = () => r.result.createObjectStore(storeName); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const run = async (mode, fn) => { const db = await open(); try { return await new Promise((res, rej) => { const tx = db.transaction(storeName, mode); const req = fn(tx.objectStore(storeName)); tx.oncomplete = () => res(req.result); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); }); } finally { db.close(); } };
  return { getItem: (k) => run('readonly', (st) => st.get(k)).then((v) => v ?? null), setItem: (k, v) => run('readwrite', (st) => st.put(v, k)), removeItem: (k) => run('readwrite', (st) => st.delete(k)), clear: () => run('readwrite', (st) => st.clear()) };
}

/** Methods a wallet (not a node) answers. They pass through the wallet gate: scripted latency / rejection. */
const WALLET_METHODS = new Set(['eth_sendTransaction', 'eth_requestAccounts', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_requestPermissions']);
const SIGNING_METHODS = new Set(['eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4']);

/** EIP-1193 / JSON-RPC error: { code, message, data }. It extends viem's BaseError on purpose: viem passes its own
 *  error classes through untouched (like the errors its http transport raises), while a foreign error with an
 *  unknown code is wrapped as "unknown" and retried three times with backoff — a full second per reverted estimate. */
export class OfflineStateError extends Error { constructor(m) { super(m); this.name = 'OfflineStateError'; } }

class RpcError extends ViemBaseError {
  constructor(code, message, data) { super(message, { name: 'RpcError', details: message }); this.code = code; this.data = data; }
}

/** Anvil-compatible revert error, so viem decodes custom errors / reason strings unchanged. */
function revertError(r) {
  const data = bytesToHex(r.returnValue ?? new Uint8Array());
  const kind = r.error ?? 'revert';
  if (kind === 'revert') return new RpcError(3, 'execution reverted', data);
  return new RpcError(-32000, `execution failed: ${kind}`, data);
}

/** Load the revm/WebAssembly engine (package `terrarium-evm`). In Node the wasm bytes are read from disk; in the browser
 *  the glue resolves the .wasm next to itself (Vite turns that into an asset, or a data URL in the standalone bundle). */
async function loadRevm(o = {}) {
  const mod = o.module ?? (await import('terrarium-evm'));
  if (o.wasm) await mod.default({ module_or_path: o.wasm });
  else if (globalThis.process?.versions?.node) { const fs = await import(/* @vite-ignore */ 'node:' + 'fs'); await mod.default({ module_or_path: fs.readFileSync(new URL('./terrarium_evm_bg.wasm', import.meta.resolve('terrarium-evm'))) }); }
  else await mod.default();
  return mod;
}

export async function createTerrarium(opts = {}) {
  const chainId = opts.chainId ?? 31337;
  const hardfork = opts.hardfork ?? Hardfork.Cancun;
  const common = new Common({ chain: { ...Mainnet, chainId, name: "sim" }, hardfork });
  // test-mode knobs: an injectable clock (seconds), a seeded PRNG for actors, fast gas (block limit, no estimation)
  const clock = opts.clock ?? (() => Math.floor(Date.now() / 1000));
  const seed = opts.seed ?? (Date.now() >>> 0);
  const random = mulberry32(seed);
  // wallet realism: how a real wallet fails. Mutable at runtime (dev bar / tests) via terrarium_setWallet.
  const walletKnobs = { rejectNext: 0, latencyMs: 0, receiptLagMs: 0, ...(opts.wallet ?? {}) };
  const extensions = new Map(Object.entries(opts.methods ?? {}));   // scenario-level RPC methods (terrarium_*)

  // ---- state: in-memory, or lazily forked from a live RPC ------------------------------------
  // 'merkle' (default): a real Merkle Patricia trie, so every block header carries a real stateRoot.
  // 'simple': flat maps, a little faster, stateRoot is the `stateRoot` option (default zero). Fork mode has no local
  // trie (remote state is unknown), so it also reports the placeholder.
  const stateMode = opts.fork ? 'rpc' : (opts.state ?? 'merkle');
  const stateManager = opts.fork
    ? Object.assign(new RecordingRPCStateManager({ provider: opts.fork.url ?? 'http://127.0.0.1:9/offline', blockTag: BigInt(opts.fork.blockNumber), common }), { offline: !!opts.fork.offline })
    : stateMode === 'merkle' ? new MerkleStateManager({ common }) : new SimpleStateManager({ common });

  const sm = stateManager;

  // ---- execution engine: revm compiled to WebAssembly. (The @ethereumjs/vm engine was removed in 0.3.) ------------
  if (opts.engine !== undefined && opts.engine !== 'revm') throw new Error(`engine '${opts.engine}' is not available: revm (WebAssembly) is the only execution engine since terrarium 0.3`);
  const engine = 'revm';
  const revm = await loadRevm(opts.revm);

  // ---- write log: every local state write is recorded so dumpState() can serialize the diff -----
  // ---- state mirror: revm reads state synchronously, the state managers are async. Every write goes
  //      through these hooks, so a checkpoint-aware mirror of everything written since boot can answer most reads
  //      synchronously; anything else is a "miss": revm aborts, the miss is loaded (from the trie, or the forked
  //      chain — recorded as usual), and the transaction is re-run. Misses converge fast: state loaded on a miss was
  //      never written since boot, so it is committed truth and lands in the base layer.
  const touched = { accounts: new Set(), code: new Set(), storage: new Map() };
  const KECCAK_EMPTY = bytesToHex(KECCAK256_NULL);
  const newLayer = () => ({ accounts: new Map(), code: new Map(), storage: new Map(), cleared: new Set() });
  const mirror = [newLayer()];
  const top = () => mirror[mirror.length - 1];
  const acctView = (acct) => (acct ? { balance: acct.balance, nonce: acct.nonce, codeHash: bytesToHex(acct.codeHash) } : null);
  const pad32hex = (v) => '0x' + bytesToHex(v).slice(2).padStart(64, '0');
  function mirrorGet(kind, key) {
    for (let i = mirror.length - 1; i >= 0; i--) { const L = mirror[i]; if (L[kind].has(key)) return L[kind].get(key); if (kind === 'storage' && L.cleared.has(key.slice(0, 42))) return ZERO32; }
    return undefined;
  }
  async function mirrorLoad(kind, key) {
    const base = mirror[0];
    if (globalThis.process?.env?.TERRARIUM_DEBUG) console.log('[miss]', kind, key);
    if (kind === 'accounts') base.accounts.set(key, acctView(await sm.getAccount(createAddressFromString(key))));
    else if (kind === 'code') base.code.set(key, bytesToHex(await sm.getCode(createAddressFromString(key))));
    else { const [addr, slot] = key.split(':'); base.storage.set(key, pad32hex(await sm.getStorage(createAddressFromString(addr), hexToBytes(slot)))); }
  }
  {
    const origPut = sm.putAccount.bind(sm); sm.putAccount = async (a, acct) => { touched.accounts.add(a.toString()); await origPut(a, acct); top().accounts.set(a.toString().toLowerCase(), acctView(acct)); };
    const origDel = sm.deleteAccount.bind(sm); sm.deleteAccount = async (a) => { touched.accounts.add(a.toString()); await origDel(a); const k = a.toString().toLowerCase(); top().accounts.set(k, null); top().code.set(k, '0x'); top().cleared.add(k); };
    const origMod = sm.modifyAccountFields.bind(sm); sm.modifyAccountFields = async (a, f) => { touched.accounts.add(a.toString()); await origMod(a, f); top().accounts.set(a.toString().toLowerCase(), acctView(await sm.getAccount(a))); };
    // (no getAccount here: during a fixture restore code is seeded before accounts, and a read would go to the forked chain)
    const origCode = sm.putCode.bind(sm); sm.putCode = async (a, v) => { touched.code.add(a.toString()); touched.accounts.add(a.toString()); await origCode(a, v); const k = a.toString().toLowerCase(); top().code.set(k, bytesToHex(v)); const cur = mirrorGet('accounts', k); if (cur) top().accounts.set(k, { ...cur, codeHash: keccak256(bytesToHex(v)) }); };
    const origStorage = sm.putStorage.bind(sm); sm.putStorage = async (a, k, v) => { const key = a.toString(); if (!touched.storage.has(key)) touched.storage.set(key, new Set()); touched.storage.get(key).add(bytesToHex(k)); await origStorage(a, k, v); top().storage.set(`${key.toLowerCase()}:${pad32hex(k)}`, pad32hex(v)); };
    const origClear = sm.clearStorage.bind(sm); sm.clearStorage = async (a) => { await origClear(a); const k = a.toString().toLowerCase(); top().cleared.add(k); for (const key of [...top().storage.keys()]) if (key.startsWith(k + ':')) top().storage.delete(key); };
    const origCp = sm.checkpoint.bind(sm); sm.checkpoint = async () => { await origCp(); mirror.push(newLayer()); };
    const origCommit = sm.commit.bind(sm); sm.commit = async () => { await origCommit(); if (mirror.length > 1) { const L = mirror.pop(), P = top(); for (const k of L.cleared) { P.cleared.add(k); for (const key of [...P.storage.keys()]) if (key.startsWith(k + ':')) P.storage.delete(key); } for (const kind of ['accounts', 'code', 'storage']) for (const [k, v] of L[kind]) P[kind].set(k, v); } };
    const origRevert = sm.revert.bind(sm); sm.revert = async () => { await origRevert(); if (mirror.length > 1) mirror.pop(); };
  }

  // ---- execution result shape ---------------------------------------------------------------------------------
  // { success, error, gasUsed, gasRefund, returnValue: Uint8Array, logs: [[addr, topics[], data]] (bytes), createdAddress, sloads: [{address, slot}] }
  // Log bloom (yellow paper, 2048 bits): for each of the first three 16-bit words of keccak256(x), the low 11 bits index a bit.
  const BLOOM_BYTES = 256;
  function bloomAdd(bits, data) { const h = keccak256(data, 'bytes'); for (let i = 0; i < 3; i++) { const loc = ((h[2 * i] << 8) | h[2 * i + 1]) & 2047; bits[BLOOM_BYTES - 1 - (loc >> 3)] |= 1 << (loc & 7); } }
  const bloomOf = (logs) => { const bits = new Uint8Array(BLOOM_BYTES); for (const [addr, topics] of logs) { bloomAdd(bits, addr); for (const t of topics) bloomAdd(bits, t); } return bits; };
  const bloomOr = (into, other) => { for (let i = 0; i < BLOOM_BYTES; i++) into[i] |= other[i]; return into; };
  /** EIP-2718 typed receipt: txType || RLP([status, cumulativeGasUsed, logsBloom, logs]) (EIP-658 status, not a state root). */
  const encodeReceipt = (r, txType) => { const body = RLP.encode([r.status ? Uint8Array.of(1) : new Uint8Array(), r.cumulativeBlockGasUsed === 0n ? new Uint8Array() : numberToBytes(r.cumulativeBlockGasUsed), r.bitvector, r.logs]); return txType === 0 ? body : concatBytes([Uint8Array.of(txType), body]); };
  const msgOf = (tx) => ({ from: tx.getSenderAddress().toString(), to: tx.to ? tx.to.toString() : null, value: tx.value, data: bytesToHex(tx.data), gasLimit: tx.gasLimit, gasPrice: tx.maxFeePerGas ?? tx.gasPrice ?? 0n, priorityFee: tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n, nonce: tx.nonce });
  const misses = [];
  const stats = { runs: 0, rounds: 0, wasmMs: 0 };
  // Without a fork, the mirror has seen every write since genesis: something it has never seen simply does not exist
  // (account) or is zero (slot). No round trip, no re-run. With a fork the truth may be remote: load it (recorded).
  const local = stateMode !== 'rpc';
  const revmHost = {
    account(address) {
      const key = address.toLowerCase(); let a = mirrorGet('accounts', key);
      if (a === undefined) {
        if (local) { mirror[0].accounts.set(key, null); a = null; }
        else {
          // fork mode. A DELEGATECALL target (proxy implementation) only needs its code, which the JS engine reads without
          // ever loading the account — so recorded fixtures have the code but not the account. Synthesize it rather than
          // fetch: balance/nonce of an implementation contract are irrelevant to the call, and offline replay stays offline.
          const code = mirrorGet('code', key);
          if (code !== undefined && code !== '0x') { a = { balance: 0n, nonce: 1n, codeHash: keccak256(code) }; mirror[0].accounts.set(key, a); }
          else { misses.push(() => mirrorLoad('accounts', key)); throw { missing: true }; }
        }
      }
      if (a === null) return null;
      let code = '0x';
      if (a.codeHash !== KECCAK_EMPTY) { code = mirrorGet('code', key); if (code === undefined) { misses.push(() => mirrorLoad('code', key)); throw { missing: true }; } }
      return { balance: hex(a.balance), nonce: hex(a.nonce), codeHash: a.codeHash, code };
    },
    storage(address, slot) { const key = `${address.toLowerCase()}:${slot.toLowerCase()}`; const v = mirrorGet('storage', key); if (v !== undefined) return v; if (local) { mirror[0].storage.set(key, ZERO32); return ZERO32; } misses.push(() => mirrorLoad('storage', key)); throw { missing: true }; },
    blockHash(n) { return blocks.find((b) => b.number === BigInt(Math.trunc(n)))?.hash ?? ZERO32; },
  };
  async function applyRevmState(changes) {
    for (const c of changes) {
      const a = createAddressFromString(c.address);
      if (c.deleted) { await sm.deleteAccount(a); continue; }
      if (c.code) await sm.putCode(a, hexToBytes(c.code));
      await sm.modifyAccountFields(a, { balance: hexToBigInt(c.balance), nonce: hexToBigInt(c.nonce) });
      for (const [slot, value] of c.storage) await sm.putStorage(a, hexToBytes(slot), hexToBytes(value));
    }
  }
  async function execRevm({ tx, msg, block, flags = {} }) {
    let m = tx ? msgOf(tx) : { ...msg, gasPrice: 0n, priorityFee: 0n, nonce: 0n };
    if (!tx) flags = { ...flags, skipBalance: true, skipNonce: true, noBaseFee: true, skipEip3607: true };
    const req = JSON.stringify({ tx: { from: m.from, to: m.to, value: hex(m.value), data: m.data, gasLimit: hex(m.gasLimit), gasPrice: hex(m.gasPrice), priorityFee: hex(m.priorityFee), nonce: hex(m.nonce), txType: 2 },
      block: { number: hex(block.header.number), timestamp: hex(block.header.timestamp), gasLimit: hex(block.header.gasLimit), baseFee: hex(block.header.baseFeePerGas ?? 0n) },
      cfg: { chainId, spec: String(hardfork), skipBalance: !!flags.skipBalance, skipNonce: !!flags.skipNonce, skipBlockGasLimit: true, noBaseFee: !!flags.noBaseFee, skipEip3607: !!flags.skipEip3607, traceSloads: !!flags.traceSloads } });
    stats.runs++;
    for (let round = 0; ; round++) {
      misses.length = 0; stats.rounds++;
      let out;
      const t0 = Date.now();
      try { out = JSON.parse(revm.run(revmHost, req)); stats.wasmMs += Date.now() - t0; }
      catch (e) {
        stats.wasmMs += Date.now() - t0;
        if (misses.length) { if (round > 100000) throw new Error('revm: state loading did not converge'); for (const load of misses.splice(0)) await load(); continue; }
        const message = String(e?.message ?? e);
        throw new Error(message.startsWith('invalid:') ? message : `revm: ${message}`);
      }
      await applyRevmState(out.state);
      return { success: out.success, error: out.success ? null : out.reason, gasUsed: BigInt(out.gasUsed), gasRefund: BigInt(out.gasRefunded), returnValue: hexToBytes(out.output), logs: out.logs.map((l) => [hexToBytes(l.address), l.topics.map(hexToBytes), hexToBytes(l.data)]), createdAddress: out.created, sloads: out.sloads.map(([address, slot]) => ({ address: address.toLowerCase(), slot })) };
    }
  }
  const exec = execRevm;

  // ---- chain bookkeeping ----------------------------------------------------------------------
  const blocks = [];          // index = block number - genesisNumber
  const txs = new Map();      // hash -> { tx, rpc, receipt, blockNumber }
  const pending = [];         // mempool (in order)
  const filters = new Map();
  const logListeners = [];    // "actor" hooks
  const emitter = new Map();  // EIP-1193 events
  let nextFilterId = 1;
  let baseFee = opts.baseFeePerGas ?? GWEI;
  let gasLimit = opts.blockGasLimit ?? 30_000_000n;
  let timeOffset = 0n;        // evm_increaseTime
  let nextTimestamp = null;   // evm_setNextBlockTimestamp
  let mining = opts.mining ?? { mode: 'auto' };
  const journal = [];          // state-changing RPC calls, replayable onto fresh (or new!) bytecode
  let recording = true;
  const tsQueue = [];          // block timestamps to reuse during replay (determinism)
  let persister = null, persistKey = null, persistTimer = null;
  const dealtSlots = new Map(); // token -> balance slot discovered by probing
  const impersonated = new Set();
  const exclusive = createLock();
  const accounts = (opts.keys ?? TEST_KEYS).map((k) => privateKeyToAccount(k));
  const keyOf = new Map(accounts.map((a, i) => [a.address.toLowerCase(), (opts.keys ?? TEST_KEYS)[i]]));

  const genesisNumber = opts.fork ? BigInt(opts.fork.blockNumber) + 1n : 0n;
  const now = () => BigInt(clock()) + timeOffset;

  function pushBlock(header, txHashes, receipts) {
    const b = { ...header, transactions: txHashes, receipts };
    blocks.push(b);
    return b;
  }
  const stateRootOf = async () => (stateMode === 'merkle' ? bytesToHex(await sm.getStateRoot()) : (opts.stateRoot ?? ZERO32));
  /** A real, verifiable header: real stateRoot (merkle mode), transactions trie, receipts trie and bloom. A client can
   *  recompute the hash from the RPC fields and the roots from the returned txs and receipts (test/uniswap-v2.mjs does). */
  async function sealHeader({ number, parentHash, timestamp, gasUsed, txs, receipts }) {
    const trie = new MerklePatriciaTrie();
    for (const [i, r] of receipts.entries()) await trie.put(RLP.encode(i), encodeReceipt(r, txs[i].type));
    const bloom = new Uint8Array(BLOOM_BYTES);
    for (const r of receipts) bloomOr(bloom, r.bitvector);
    const header = createBlockHeader({ number, parentHash, timestamp, gasLimit, gasUsed, baseFeePerGas: baseFee, coinbase: '0x0000000000000000000000000000000000000000',
      stateRoot: await stateRootOf(), transactionsTrie: await genTransactionsTrieRoot(txs), receiptTrie: trie.root(), logsBloom: bloom }, { common, skipConsensusFormatValidation: true });
    let size = 0; try { size = new Block(header, txs, [], [], { common, skipConsensusFormatValidation: true }).serialize().length; } catch { size = header.serialize().length; }
    return { hash: bytesToHex(header.hash()), header: header.toJSON(), size: hex(size) };
  }

  // fund test accounts, then seal a real genesis over that state
  for (const a of accounts) await sm.putAccount(createAddressFromString(a.address), new Account(0n, 10_000n * 10n ** 18n));
  {
    const ts = now();
    const sealed = await sealHeader({ number: genesisNumber, parentHash: ZERO32, timestamp: ts, gasUsed: 0n, txs: [], receipts: [] });
    pushBlock({ number: genesisNumber, ...sealed, parentHash: ZERO32, timestamp: ts, baseFeePerGas: baseFee, gasLimit, gasUsed: 0n, logs: [] }, [], []);
  }
  const latest = () => blocks[blocks.length - 1];

  const nextTimestampFor = (parent) => nextTimestamp ?? (parent.timestamp + 1n > now() ? parent.timestamp + 1n : now());
  /** The block a tx sent right now would land in. eth_estimateGas MUST simulate against it, not against `latest`:
   *  a contract that branches on block.timestamp (Uniswap's price accumulators write two extra slots when time has
   *  passed since the last trade) costs more gas in the next block than in the current one — estimate against the
   *  current one and the real tx runs out of gas. geth and Anvil estimate on the pending block; so do we. */
  function pendingBlock() { const parent = latest(); return execBlock({ number: parent.number + 1n, parentHash: parent.hash, timestamp: tsQueue.length ? tsQueue[0] : nextTimestampFor(parent), baseFeePerGas: baseFee, gasLimit, gasUsed: 0n }); }
  function execBlock(header) {
    return createBlock({ header: { number: header.number, timestamp: header.timestamp, gasLimit: header.gasLimit, baseFeePerGas: header.baseFeePerGas, parentHash: header.parentHash, coinbase: '0x0000000000000000000000000000000000000000' } }, { common, skipConsensusFormatValidation: true, freeze: false });
  }

  // ---- transaction plumbing --------------------------------------------------------------------
  async function buildTx(p) {
    const from = getAddress(p.from);
    const fromAddr = createAddressFromString(from);
    const acct = (await sm.getAccount(fromAddr)) ?? new Account();
    const data = {
      chainId: BigInt(chainId),
      nonce: p.nonce !== undefined ? hexToBigInt(p.nonce) : acct.nonce,
      maxFeePerGas: p.maxFeePerGas ? hexToBigInt(p.maxFeePerGas) : (p.gasPrice ? hexToBigInt(p.gasPrice) : baseFee * 2n),
      maxPriorityFeePerGas: p.maxPriorityFeePerGas ? hexToBigInt(p.maxPriorityFeePerGas) : 1n,
      gasLimit: p.gas ? hexToBigInt(p.gas) : 0n,
      to: p.to ?? undefined,
      value: p.value ? hexToBigInt(p.value) : 0n,
      data: p.data ?? p.input ?? '0x',
    };
    if (data.gasLimit === 0n) data.gasLimit = opts.gasEstimation === 'fast' ? gasLimit : await estimateGas({ ...p, from });
    const key = keyOf.get(from.toLowerCase());
    if (key) return createFeeMarket1559Tx(data, { common }).sign(hexToBytes(key));
    if (!impersonated.has(from.toLowerCase()) && !opts.impersonateAll) throw new RpcError(-32000, `no key for ${from}; call anvil_impersonateAccount first`);
    return impersonatedTx(data, from);
  }
  /** A tx whose sender we dictate (impersonation). Like Anvil, it carries a fake signature that encodes the sender
   *  (r = from address), so it serializes, hashes and sits in the transactions trie like any other tx. */
  function impersonatedTx(data, from) {
    const fromAddr = createAddressFromString(from);
    const tx = createFeeMarket1559Tx({ ...data, v: 0n, r: hexToBigInt(from), s: 1n }, { common, freeze: false });
    tx.getSenderAddress = () => fromAddr;
    tx.getSenderPublicKey = () => new Uint8Array(64);
    return tx;
  }

  function txToRpc(tx, hash, from) {
    const j = tx.toJSON();
    return { hash, nonce: j.nonce, from, to: j.to ?? null, value: j.value, gas: j.gasLimit, input: j.data, type: '0x2', chainId: hex(chainId),
      maxFeePerGas: j.maxFeePerGas, maxPriorityFeePerGas: j.maxPriorityFeePerGas, gasPrice: j.maxFeePerGas, accessList: [], v: j.v ?? '0x0', r: j.r ?? '0x0', s: j.s ?? '0x0',
      blockHash: null, blockNumber: null, transactionIndex: null };
  }

  async function mine(count = 1) {
    for (let i = 0; i < count; i++) {
      const parent = latest();
      const ts = tsQueue.length ? tsQueue.shift() : nextTimestampFor(parent);
      nextTimestamp = null;
      const header = { number: parent.number + 1n, parentHash: parent.hash, timestamp: ts, baseFeePerGas: baseFee, gasLimit, gasUsed: 0n };
      const block = execBlock(header);
      const batch = pending.splice(0, pending.length);
      const receipts = [], hashes = [], blockLogs = [], sealTxs = [], sealReceipts = [];
      let cumulative = 0n, logIndex = 0;
      for (let idx = 0; idx < batch.length; idx++) {
        const entry = batch[idx];
        let r;
        try {
          r = await exec({ tx: entry.tx, block, flags: { blockGasUsed: cumulative } });
        } catch (e) { // invalid tx (nonce too low, insufficient funds...): a node would drop it silently and the dapp
          // would wait for a receipt forever. Record a failed receipt instead so waiters resolve and the reason is visible.
          const t = txs.get(entry.hash); t.error = String(e.message);
          receipts.push({ transactionHash: entry.hash, transactionIndex: hex(idx), from: entry.from, to: entry.rpc.to, cumulativeGasUsed: hex(cumulative), gasUsed: '0x0', effectiveGasPrice: hex(baseFee), contractAddress: null, logs: [], logsBloom: '0x' + '00'.repeat(256), status: '0x0', type: '0x2', droppedReason: t.error });
          hashes.push(entry.hash); sealTxs.push(entry.tx); sealReceipts.push({ status: 0, cumulativeBlockGasUsed: cumulative, bitvector: new Uint8Array(256), logs: [] }); continue;
        }
        cumulative += r.gasUsed;
        if (globalThis.process?.env?.TERRARIUM_DEBUG && !r.success) console.log('[tx reverted]', entry.hash, r.error, bytesToHex(r.returnValue), 'gasUsed', r.gasUsed, 'gasLimit', entry.tx.gasLimit);
        const bloom = bloomOf(r.logs);
        const logs = r.logs.map(([addr, topics, data]) => ({ address: bytesToHex(addr), topics: topics.map(bytesToHex), data: bytesToHex(data), blockNumber: hex(header.number), transactionHash: entry.hash, transactionIndex: hex(idx), logIndex: hex(logIndex++), removed: false }));
        const receipt = { transactionHash: entry.hash, transactionIndex: hex(idx), from: entry.from, to: entry.rpc.to, cumulativeGasUsed: hex(cumulative), gasUsed: hex(r.gasUsed), effectiveGasPrice: hex(entry.tx.maxPriorityFeePerGas + baseFee < entry.tx.maxFeePerGas ? entry.tx.maxPriorityFeePerGas + baseFee : entry.tx.maxFeePerGas),
          contractAddress: r.createdAddress, logs, logsBloom: bytesToHex(bloom), status: r.success ? '0x1' : '0x0', type: '0x2' };
        receipts.push(receipt); hashes.push(entry.hash); blockLogs.push(...logs); sealTxs.push(entry.tx); sealReceipts.push({ status: r.success ? 1 : 0, cumulativeBlockGasUsed: cumulative, bitvector: bloom, logs: r.logs });
      }
      header.gasUsed = cumulative;
      Object.assign(header, await sealHeader({ number: header.number, parentHash: header.parentHash, timestamp: header.timestamp, gasUsed: cumulative, txs: sealTxs, receipts: sealReceipts }));
      for (const r of receipts) { r.blockHash = header.hash; r.blockNumber = hex(header.number); for (const l of r.logs) l.blockHash = header.hash; const t = txs.get(r.transactionHash); t.receipt = r; t.minedAt = Date.now(); t.rpc = { ...t.rpc, blockHash: header.hash, blockNumber: hex(header.number), transactionIndex: r.transactionIndex }; }
      pushBlock({ ...header, logs: blockLogs }, hashes, receipts);
      schedulePersist();
      emit('message', { type: 'eth_subscription', data: { subscription: '0x1', result: rpcBlock(latest(), false) } });
      // actors: let scripts react to what just happened (after the block is final)
      for (const log of blockLogs) for (const l of logListeners) if (matchLog(log, l.filter)) queueMicrotask(() => l.handler(log, { blockNumber: header.number }));
    }
    return latest();
  }

  async function submit(tx, from) {
    const hash = bytesToHex(tx.hash());
    txs.set(hash, { tx, rpc: txToRpc(tx, hash, from), receipt: null });
    pending.push({ tx, hash, from, rpc: txToRpc(tx, hash, from) });
    if (mining.mode === 'auto') await mine(1);
    return hash;
  }

  async function withRollback(fn) {
    await sm.checkpoint();
    try { return await fn(); } finally { await sm.revert(); }
  }

  /** geth-style state override set: { [addr]: { balance, nonce, code, state, stateDiff } } — "what if" reads. */
  async function applyOverrides(overrides) {
    for (const [addr, o] of Object.entries(overrides ?? {})) {
      const a = createAddressFromString(addr);
      if (o.code) await sm.putCode(a, hexToBytes(o.code));
      if (o.balance !== undefined || o.nonce !== undefined) await sm.modifyAccountFields(a, { ...(o.balance !== undefined && { balance: hexToBigInt(o.balance) }), ...(o.nonce !== undefined && { nonce: hexToBigInt(o.nonce) }) });
      if (o.state) { await sm.clearStorage(a); for (const [k, v] of Object.entries(o.state)) await sm.putStorage(a, hexToBytes(pad32(k)), hexToBytes(pad32(v))); }
      if (o.stateDiff) for (const [k, v] of Object.entries(o.stateDiff)) await sm.putStorage(a, hexToBytes(pad32(k)), hexToBytes(pad32(v)));
    }
  }

  async function call(p, blockTag, overrides) {
    const block = blockTag === 'pending' ? pendingBlock() : execBlock(latest());
    return withRollback(async () => {
      await applyOverrides(overrides);
      const r = await exec({ msg: { from: p.from ?? accounts[0].address, to: p.to ?? null, data: p.data ?? p.input ?? '0x', value: p.value ? hexToBigInt(p.value) : 0n, gasLimit: p.gas ? hexToBigInt(p.gas) : gasLimit }, block });
      if (!r.success) throw revertError(r);
      return bytesToHex(r.returnValue);
    });
  }

  /** Execute a hypothetical tx with a given gas limit on a rollback — real transaction semantics (intrinsic gas,
   *  63/64 rule for sub-calls, refunds), no state change. */
  async function simulateTx(p, gasLimit) {
    const from = getAddress(p.from ?? accounts[0].address);
    const acct = (await sm.getAccount(createAddressFromString(from))) ?? new Account();
    const tx = impersonatedTx({ chainId: BigInt(chainId), nonce: acct.nonce, maxFeePerGas: baseFee * 2n, maxPriorityFeePerGas: 1n, gasLimit, to: p.to ?? undefined, value: p.value ? hexToBigInt(p.value) : 0n, data: p.data ?? p.input ?? '0x' }, from);
    return withRollback(() => exec({ tx, block: pendingBlock(), flags: { skipNonce: true, skipBalance: true } }));
  }
  /** geth/anvil-style estimation: one full run, an optimistic 64/63 probe, then binary search if needed. */
  async function estimateGas(p) {
    const cap = p.gas ? hexToBigInt(p.gas) : gasLimit;
    const first = await simulateTx(p, cap);
    if (!first.success) throw revertError(first);
    const ok = async (g) => { try { const r = await simulateTx(p, g); return r.success; } catch { return false; } };
    let lo = first.gasUsed - 1n, hi = cap;
    const optimistic = ((first.gasUsed + first.gasRefund) * 64n) / 63n + 1n;   // usually exact
    if (optimistic < hi && (await ok(optimistic))) hi = optimistic;
    while (lo + 1n < hi) {                                                             // shrink to the minimum that succeeds
      if (hi - lo <= hi / 64n) break;                                                  // 1.5 % tolerance like geth
      const mid = (lo + hi) / 2n;
      if (await ok(mid)) hi = mid; else lo = mid;
    }
    return hi;
  }

  // ---- RPC formatting ----------------------------------------------------------------------------
  function rpcBlock(b, full) {
    const transactions = full ? b.transactions.map((h) => txs.get(h).rpc) : b.transactions;
    const h = b.header;   // sealed header (blocks restored from a pre-0.2 dump have none: zero roots, as before)
    if (!h) return { number: hex(b.number), hash: b.hash, parentHash: b.parentHash, nonce: '0x0000000000000000', sha3Uncles: ZERO32, logsBloom: '0x' + '00'.repeat(256), transactionsRoot: ZERO32, stateRoot: ZERO32, receiptsRoot: ZERO32, miner: '0x0000000000000000000000000000000000000000', difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x400', gasLimit: hex(b.gasLimit), gasUsed: hex(b.gasUsed), timestamp: hex(b.timestamp), baseFeePerGas: hex(b.baseFeePerGas), mixHash: ZERO32, uncles: [], withdrawals: [], withdrawalsRoot: EMPTY_ROOT, blobGasUsed: '0x0', excessBlobGas: '0x0', parentBeaconBlockRoot: ZERO32, transactions };
    return { number: h.number, hash: b.hash, parentHash: h.parentHash, nonce: h.nonce, sha3Uncles: h.uncleHash, logsBloom: h.logsBloom, transactionsRoot: h.transactionsTrie, stateRoot: h.stateRoot, receiptsRoot: h.receiptTrie, miner: h.coinbase, difficulty: h.difficulty, totalDifficulty: '0x0', extraData: h.extraData, size: b.size ?? '0x0', gasLimit: h.gasLimit, gasUsed: h.gasUsed, timestamp: h.timestamp, baseFeePerGas: h.baseFeePerGas, mixHash: h.mixHash, uncles: [], withdrawals: [], withdrawalsRoot: h.withdrawalsRoot ?? EMPTY_ROOT, blobGasUsed: h.blobGasUsed ?? '0x0', excessBlobGas: h.excessBlobGas ?? '0x0', parentBeaconBlockRoot: h.parentBeaconBlockRoot ?? ZERO32, transactions };
  }
  /** The block the next transaction lands in, as geth/Anvil report `pending`: real next number and timestamp, no hash.
   *  A dapp that derives deadlines from it is correct on an idle chain (where `latest` may be hours old) and when the
   *  dev bar has shifted the clock. */
  function rpcPendingBlock(full) {
    const h = pendingBlock().header, parent = latest();
    return { number: hex(h.number), hash: null, parentHash: parent.hash, nonce: '0x0000000000000000', sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347', logsBloom: '0x' + '00'.repeat(256), transactionsRoot: EMPTY_ROOT, stateRoot: parent.header?.stateRoot ?? ZERO32, receiptsRoot: EMPTY_ROOT, miner: '0x0000000000000000000000000000000000000000', difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x', size: '0x0', gasLimit: hex(gasLimit), gasUsed: '0x0', timestamp: hex(h.timestamp), baseFeePerGas: hex(baseFee), mixHash: ZERO32, uncles: [], withdrawals: [], withdrawalsRoot: EMPTY_ROOT, blobGasUsed: '0x0', excessBlobGas: '0x0', parentBeaconBlockRoot: ZERO32, transactions: pending.map((p) => (full ? p.rpc : p.hash)) };
  }
  function blockByTag(tag) {
    if (tag === undefined || tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized') return latest();
    if (tag === 'earliest') return blocks[0];
    if (typeof tag === 'object' && tag.blockHash) return blocks.find((b) => b.hash === tag.blockHash);
    const n = hexToBigInt(typeof tag === 'object' ? tag.blockNumber : tag);
    return blocks[Number(n - genesisNumber)];
  }
  function matchLog(log, f) {
    if (f.address) { const list = Array.isArray(f.address) ? f.address : [f.address]; if (!list.some((a) => isAddressEqual(a, log.address))) return false; }
    if (f.topics) for (let i = 0; i < f.topics.length; i++) { const t = f.topics[i]; if (t == null) continue; const opts = Array.isArray(t) ? t : [t]; if (!opts.some((x) => x?.toLowerCase() === log.topics[i]?.toLowerCase())) return false; }
    return true;
  }
  function resolveNumber(tag, dflt) {
    if (tag === undefined || tag === null) return dflt;
    if (typeof tag === 'string' && tag.startsWith('0x')) return hexToBigInt(tag);
    return blockByTag(tag)?.number ?? dflt;
  }
  function getLogs(f) {
    if (f.blockHash) return (blocks.find((b) => b.hash === f.blockHash)?.logs ?? []).filter((l) => matchLog(l, f));
    const from = resolveNumber(f.fromBlock, genesisNumber);
    const to = resolveNumber(f.toBlock, latest().number);
    const out = [];
    for (const b of blocks) if (b.number >= from && b.number <= to) for (const l of b.logs) if (matchLog(l, f)) out.push(l);
    return out;
  }

  // ---- EIP-1193 events ------------------------------------------------------------------------------
  function emit(ev, payload) { for (const fn of emitter.get(ev) ?? []) fn(payload); }
  /** A real wallet is slow and sometimes says no. Runs *outside* the state lock so node reads keep flowing. */
  async function walletGate(method) {
    if (!WALLET_METHODS.has(method)) return;
    if (walletKnobs.latencyMs > 0) await new Promise((r) => setTimeout(r, walletKnobs.latencyMs));
    if (walletKnobs.rejectNext > 0 && SIGNING_METHODS.has(method)) { walletKnobs.rejectNext--; throw new RpcError(4001, 'User rejected the request.'); }
  }
  const eip1193 = {
    on(ev, fn) { if (!emitter.has(ev)) emitter.set(ev, new Set()); emitter.get(ev).add(fn); return eip1193; },
    removeListener(ev, fn) { emitter.get(ev)?.delete(fn); return eip1193; },
    // extension methods (terrarium_*, from scenarios) run OUTSIDE the state lock: they orchestrate other RPC calls, each of
    // which takes the lock itself. Running them inside would deadlock on their first inner request.
    request(args) { const ext = extensions.get(args.method); if (ext) return Promise.resolve().then(() => ext(...(args.params ?? []))); return walletGate(args.method).then(() => exclusive(() => handle(args))); },
  };
  /** The same chain seen through a node RPC instead of a wallet: no accounts, no signing. What a dapp's read
   *  transport talks to in production, so reads and writes can be tested as two different endpoints. */
  const nodeProvider = {
    on: eip1193.on, removeListener: eip1193.removeListener,
    request(args) {
      if (args.method === 'eth_accounts') return Promise.resolve([]);
      if (WALLET_METHODS.has(args.method)) return Promise.reject(new RpcError(4100, `${args.method}: this endpoint is a node, not a wallet`));
      const ext = extensions.get(args.method); if (ext) return Promise.resolve().then(() => ext(...(args.params ?? [])));
      return exclusive(() => handle(args));
    },
  };
  async function handle(req) {
    const result = await dispatch(req);
    if (recording && STATE_CHANGING.has(req.method)) { journal.push({ method: req.method, params: req.params ?? [] }); schedulePersist(); }
    return result;
  }
  async function dispatch({ method, params = [] }) {
      switch (method) {
        // --- node -------------------------------------------------------------------------------
        case 'eth_chainId': return hex(chainId);
        case 'net_version': return String(chainId);
        case 'web3_clientVersion': return 'terrarium/0.3.0';
        case 'eth_syncing': return false;
        case 'eth_blockNumber': return hex(latest().number);
        case 'eth_getBlockByNumber': { if (params[0] === 'pending') return rpcPendingBlock(!!params[1]); const b = blockByTag(params[0]); return b ? rpcBlock(b, !!params[1]) : null; }
        case 'eth_getBlockByHash': { const b = blocks.find((x) => x.hash === params[0]); return b ? rpcBlock(b, !!params[1]) : null; }
        case 'eth_getBalance': return hex(((await sm.getAccount(createAddressFromString(params[0]))) ?? new Account()).balance);
        case 'eth_getTransactionCount': return hex(((await sm.getAccount(createAddressFromString(params[0]))) ?? new Account()).nonce);
        case 'eth_getCode': return bytesToHex(await sm.getCode(createAddressFromString(params[0])));
        case 'eth_getStorageAt': { const v = await sm.getStorage(createAddressFromString(params[0]), hexToBytes(numberToHex(hexToBigInt(params[1]), { size: 32 }))); return '0x' + bytesToHex(v).slice(2).padStart(64, '0'); }
        case 'eth_gasPrice': return hex(baseFee + 1n);
        case 'eth_maxPriorityFeePerGas': return '0x1';
        case 'eth_feeHistory': { const n = Number(hexToBigInt(params[0])); const b = blockByTag(params[1]); const fees = Array(n + 1).fill(hex(baseFee)); const oldest = b.number - BigInt(n) + 1n; return { oldestBlock: hex(oldest < genesisNumber ? genesisNumber : oldest), baseFeePerGas: fees, gasUsedRatio: Array(n).fill(0.1), baseFeePerBlobGas: Array(n + 1).fill('0x1'), blobGasUsedRatio: Array(n).fill(0), reward: params[2] ? Array(n).fill(params[2].map(() => '0x1')) : undefined }; }
        case 'eth_call': return call(params[0], params[1], params[2]);
        case 'eth_estimateGas': return hex(await estimateGas(params[0]));
        case 'eth_sendRawTransaction': { const tx = createTxFromRLP(hexToBytes(params[0]), { common }); return submit(tx, tx.getSenderAddress().toString()); }
        case 'eth_getTransactionReceipt': { const t = txs.get(params[0]); if (!t?.receipt) return null; if (walletKnobs.receiptLagMs > 0 && Date.now() - (t.minedAt ?? 0) < walletKnobs.receiptLagMs) return null; return t.receipt; }
        case 'eth_getTransactionByHash': return txs.get(params[0])?.rpc ?? null;
        case 'eth_getLogs': return getLogs(params[0] ?? {});
        case 'eth_newFilter': filters.set(hex(nextFilterId), { type: 'logs', f: params[0] ?? {}, cursor: latest().number + 1n }); return hex(nextFilterId++);
        case 'eth_newBlockFilter': filters.set(hex(nextFilterId), { type: 'blocks', cursor: latest().number + 1n }); return hex(nextFilterId++);
        case 'eth_newPendingTransactionFilter': filters.set(hex(nextFilterId), { type: 'pending', cursor: latest().number + 1n }); return hex(nextFilterId++);
        case 'eth_getFilterChanges': { const fl = filters.get(params[0]); if (!fl) throw new RpcError(-32000, 'filter not found'); const from = fl.cursor; fl.cursor = latest().number + 1n; if (fl.type === 'blocks') return blocks.filter((b) => b.number >= from).map((b) => b.hash); if (fl.type === 'pending') return []; return getLogs({ ...fl.f, fromBlock: hex(from), toBlock: 'latest' }); }
        case 'eth_getFilterLogs': { const fl = filters.get(params[0]); return fl ? getLogs(fl.f) : []; }
        case 'eth_uninstallFilter': return filters.delete(params[0]);
        case 'eth_subscribe': return '0x1';
        case 'eth_unsubscribe': return true;
        // --- wallet -----------------------------------------------------------------------------
        case 'eth_accounts': case 'eth_requestAccounts': return accounts.map((a) => a.address);
        case 'wallet_switchEthereumChain': if (hexToBigInt(params[0].chainId) !== BigInt(chainId)) throw new RpcError(4902, 'Unrecognized chain ID'); return null;
        case 'wallet_addEthereumChain': return null;
        case 'wallet_getPermissions': case 'wallet_requestPermissions': return [{ parentCapability: 'eth_accounts' }];
        case 'wallet_revokePermissions': return null;
        case 'eth_sendTransaction': { const p = params[0]; const tx = await buildTx(p); return submit(tx, getAddress(p.from)); }
        case 'personal_sign': { const acct = accounts.find((a) => isAddressEqual(a.address, params[1])); if (!acct) throw new RpcError(4100, 'unauthorized'); return acct.signMessage({ message: { raw: params[0] } }); }
        case 'eth_signTypedData_v4': { const acct = accounts.find((a) => isAddressEqual(a.address, params[0])); if (!acct) throw new RpcError(4100, 'unauthorized'); const td = typeof params[1] === 'string' ? JSON.parse(params[1]) : params[1]; return acct.signTypedData(td); }
        // --- cheatcodes (Anvil / Hardhat names, so viem's createTestClient({ mode: 'anvil' }) works) ---
        case 'evm_mine': case 'anvil_mine': case 'hardhat_mine': { const n = params[0] !== undefined ? (typeof params[0] === 'object' ? Number(hexToBigInt(params[0].blocks ?? '0x1')) : Number(hexToBigInt(params[0]))) : 1; await mine(n); return '0x0'; }
        case 'evm_setNextBlockTimestamp': case 'anvil_setNextBlockTimestamp': nextTimestamp = BigInt(params[0]); return null;
        case 'evm_increaseTime': case 'anvil_increaseTime': timeOffset += BigInt(params[0]); return hex(timeOffset);
        case 'evm_setAutomine': case 'anvil_setAutomine': clearInterval(intervalHandle); intervalHandle = null; mining = { mode: params[0] ? 'auto' : 'manual' }; return null;
        case 'evm_setIntervalMining': case 'anvil_setIntervalMining': setIntervalMining(Number(params[0])); return null;
        case 'anvil_setBalance': case 'hardhat_setBalance': await sm.modifyAccountFields(createAddressFromString(params[0]), { balance: hexToBigInt(params[1]) }); return null;
        case 'anvil_setCode': case 'hardhat_setCode': await sm.putCode(createAddressFromString(params[0]), hexToBytes(params[1])); return null;
        case 'anvil_setNonce': case 'hardhat_setNonce': await sm.modifyAccountFields(createAddressFromString(params[0]), { nonce: hexToBigInt(params[1]) }); return null;
        case 'anvil_setStorageAt': case 'hardhat_setStorageAt': await sm.putStorage(createAddressFromString(params[0]), hexToBytes(numberToHex(hexToBigInt(params[1]), { size: 32 })), hexToBytes(numberToHex(hexToBigInt(params[2]), { size: 32 }))); return null;
        case 'anvil_impersonateAccount': case 'hardhat_impersonateAccount': impersonated.add(params[0].toLowerCase()); return null;
        case 'anvil_stopImpersonatingAccount': case 'hardhat_stopImpersonatingAccount': impersonated.delete(params[0].toLowerCase()); return null;
        case 'anvil_setNextBlockBaseFeePerGas': case 'hardhat_setNextBlockBaseFeePerGas': baseFee = hexToBigInt(params[0]); return null;
        case 'sim_deal': return deal(params[0], params[1], hexToBigInt(params[2]), params[3] ?? {});
        case 'sim_setState': return setState(params[0], params[1], params[2]);
        case 'sim_dumpState': return dumpState();
        case 'evm_snapshot': return snapshot();
        case 'evm_revert': return revertTo(params[0]);
        // --- wallet realism knobs + scenario extensions -------------------------------------------
        case 'terrarium_setWallet': Object.assign(walletKnobs, params[0] ?? {}); return { ...walletKnobs };
        case 'terrarium_getWallet': return { ...walletKnobs };
        default: { const ext = extensions.get(method); if (ext) return ext(...params); throw new RpcError(-32601, `Method not supported: ${method}`); }
      }
  }

  // ---- snapshots ------------------------------------------------------------------------------------
  const snapshots = [];
  async function snapshot() { await sm.checkpoint(); const id = hex(snapshots.length + 1); snapshots.push({ id, blocksLen: blocks.length, journalLen: journal.length, timeOffset, nextTimestamp, baseFee }); return id; }
  /** Roll back EVM state AND everything that describes it: blocks, receipts, the journal, filter cursors, the dump. */
  async function revertTo(id) {
    const i = snapshots.findIndex((s) => s.id === id); if (i < 0) return false;
    let target;
    while (snapshots.length > i) { target = snapshots.pop(); await sm.revert(); }
    blocks.length = target.blocksLen; journal.length = target.journalLen; pending.length = 0;
    timeOffset = target.timeOffset; nextTimestamp = target.nextTimestamp; baseFee = target.baseFee;   // the clock is state too
    const head = latest().number;
    for (const [h, t] of txs) if (!t.receipt || hexToBigInt(t.receipt.blockNumber) > head) txs.delete(h);
    for (const fl of filters.values()) if (fl.cursor > head + 1n) fl.cursor = head + 1n;
    schedulePersist();
    emit('message', { type: 'eth_subscription', data: { subscription: '0x1', result: rpcBlock(latest(), false) } });
    return true;
  }

  // ---- mining modes ---------------------------------------------------------------------------------
  let intervalHandle = null, followHandle = null;
  function setIntervalMining(ms) { clearInterval(intervalHandle); if (ms > 0) intervalHandle = setInterval(() => exclusive(() => mine(1)), ms); mining = { mode: ms > 0 ? 'interval' : 'manual' }; }
  /** Mirror a live chain: each new remote block -> one local block with the same number & timestamp. */
  async function followChain(url, { pollMs = 2000, onBlock } = {}) {
    mining = { mode: 'follow' };
    const rpc = async (method, params) => (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
    const tick = async () => {
      const remote = await rpc('eth_getBlockByNumber', ['latest', false]);
      const rn = hexToBigInt(remote.number);
      if (rn > latest().number) {
        // jump straight to the remote height; keep the remote timestamp so time-based UI is realistic
        const b = await exclusive(() => { blocks[blocks.length - 1] = { ...latest(), number: rn - 1n }; nextTimestamp = hexToBigInt(remote.timestamp); return mine(1); }); // re-anchor parent, then mine
        onBlock?.(b, remote);
      }
    };
    await tick();
    followHandle = setInterval(() => tick().catch(() => {}), pollMs);
  }
  function stop() { clearInterval(intervalHandle); clearInterval(followHandle); clearTimeout(persistTimer); persister = null; }

  // ---- fabricating state --------------------------------------------------------------------------
  /** Run a call while recording which storage slots `target` SLOADs (Foundry's stdstore/vm.record trick). */
  async function recordReads(target, data) {
    const r = await withRollback(() => exec({ msg: { from: accounts[0].address, to: target, data, value: 0n, gasLimit }, block: execBlock(latest()), flags: { traceSloads: true } }));
    return { reads: [...new Set(r.sloads.filter((x) => x.address === target.toLowerCase()).map((x) => x.slot))], result: r.success ? bytesToHex(r.returnValue) : null };
  }
  /** Find the slot that a view function reads *and* whose value flows to the return value. Works for
   *  Solidity & Vyper mappings, proxies (storage context = proxy), ERC-7201 namespaced storage… */
  async function findSlot(target, data) {
    const { reads, result } = await recordReads(target, data);
    if (globalThis.process?.env?.TERRARIUM_DEBUG) console.log('[reads]', target, reads, result);
    if (result === null) throw new Error(`call reverted while probing ${target}`);
    const sentinel = 0x1234567890abcdefn;
    for (const slot of reads) {
      const hit = await withRollback(async () => {
        await sm.putStorage(createAddressFromString(target), hexToBytes(slot), hexToBytes(pad32(sentinel)));
        const r = await exec({ msg: { from: accounts[0].address, to: target, data, value: 0n, gasLimit }, block: execBlock(latest()) });
        // a probe that lands on e.g. a proxy's implementation slot breaks the call (empty return) — not a hit
        if (globalThis.process?.env?.TERRARIUM_DEBUG) console.log('[probe]', slot, r.error, bytesToHex(r.returnValue));
        return r.success && r.returnValue.length >= 32 && hexToBigInt(bytesToHex(r.returnValue)) === sentinel;
      });
      if (hit) return { slot, current: hexToBigInt(result) };
    }
    throw new Error(`no direct storage slot for this read on ${target} (computed/rebasing balance?) — impersonate a holder or the minter instead`);
  }
  const erc20 = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
  /** Foundry-style `deal`: give `holder` `amount` of any ERC20 by writing its balance slot directly. */
  async function deal(token, holder, amount, { adjustTotalSupply = true } = {}) {
    const key = `${token.toLowerCase()}`;
    let found = dealtSlots.get(key)?.[holder.toLowerCase()];
    const { slot, current } = found ? { slot: found, current: hexToBigInt(await call({ to: token, data: encodeFunctionData({ abi: erc20, functionName: 'balanceOf', args: [holder] }) })) } : await findSlot(token, encodeFunctionData({ abi: erc20, functionName: 'balanceOf', args: [holder] }));
    dealtSlots.set(key, { ...(dealtSlots.get(key) ?? {}), [holder.toLowerCase()]: slot });
    await sm.putStorage(createAddressFromString(token), hexToBytes(slot), hexToBytes(pad32(amount)));
    if (adjustTotalSupply) {
      try { const ts = await findSlot(token, encodeFunctionData({ abi: erc20, functionName: 'totalSupply' })); await sm.putStorage(createAddressFromString(token), hexToBytes(ts.slot), hexToBytes(pad32(ts.current + amount - current))); } catch { /* token without a plain totalSupply slot: leave it */ }
    }
    schedulePersist();
    return slot;
  }
  /** Compute a storage slot from solc's storageLayout, e.g. slotFromLayout(layout, ['balanceOf', alice]) or ['totalSupply']. */
  function slotFromLayout(layout, path) {
    const [label, ...keys] = path;
    const v = layout.storage.find((x) => x.label === label);
    if (!v) throw new Error(`unknown variable ${label}`);
    let slot = BigInt(v.slot), type = layout.types[v.type];
    for (const k of keys) {
      if (type.encoding === 'mapping') {
        const keyType = type.key; let enc;
        if (keyType === 't_string_memory_ptr' || keyType === 't_string_storage' || keyType.startsWith('t_bytes_')) enc = concat([typeof k === 'string' && !k.startsWith('0x') ? stringToHex(k) : k, pad32(slot)]);
        else enc = concat([pad32(typeof k === 'string' ? k : BigInt(k)), pad32(slot)]);   // address / uintN / bytes32 / bool all left-pad to 32
        slot = hexToBigInt(keccak256(enc)); type = layout.types[type.value];
      } else if (type.encoding === 'dynamic_array') { slot = hexToBigInt(keccak256(pad32(slot))) + BigInt(k) * BigInt(Math.ceil(Number(layout.types[type.base].numberOfBytes) / 32)); type = layout.types[type.base]; }
      else throw new Error(`cannot index into ${type.label}`);
    }
    if (v.offset && keys.length === 0 && Number(type.numberOfBytes) < 32) throw new Error(`${label} is packed (offset ${v.offset}) — write the whole slot or use sim.setStorage`);
    return numberToHex(slot, { size: 32 });
  }
  /** Set state on one of *your* contracts by variable name using its artifact's storageLayout. */
  async function setState(address, layout, values) {
    const written = [];
    const walk = async (path, val) => {
      if (val !== null && typeof val === 'object' && !Array.isArray(val) && typeof val !== 'bigint') { for (const [k, v] of Object.entries(val)) await walk([...path, k], v); return; }
      const slot = slotFromLayout(layout, path);
      const raw = typeof val === 'boolean' ? (val ? 1n : 0n) : typeof val === 'string' && val.startsWith('0x') ? hexToBigInt(val) : BigInt(val);
      await sm.putStorage(createAddressFromString(address), hexToBytes(slot), hexToBytes(pad32(raw)));
      written.push({ path: path.map(String), slot });
    };
    for (const [k, v] of Object.entries(values)) await walk([k], v);
    schedulePersist();
    return written;
  }

  // ---- persistence: dump the diff, restore it, or replay the journal -------------------------------
  const serBlock = (b) => ({ ...b, number: hex(b.number), timestamp: hex(b.timestamp), gasLimit: hex(b.gasLimit), gasUsed: hex(b.gasUsed), baseFeePerGas: hex(b.baseFeePerGas) });
  const deserBlock = (b) => ({ ...b, number: hexToBigInt(b.number), timestamp: hexToBigInt(b.timestamp), gasLimit: hexToBigInt(b.gasLimit), gasUsed: hexToBigInt(b.gasUsed), baseFeePerGas: hexToBigInt(b.baseFeePerGas) });
  async function dumpState() {
    const keepFrom = latest().number - BigInt(opts.persist?.maxTxBlocks ?? 2000);
    const accountsOut = {};
    for (const a of touched.accounts) { const acct = await sm.getAccount(createAddressFromString(a)); accountsOut[a] = acct ? { nonce: hex(acct.nonce), balance: hex(acct.balance), codeHash: bytesToHex(acct.codeHash) } : null; }
    const codeOut = {}; for (const a of touched.code) codeOut[a] = bytesToHex(await sm.getCode(createAddressFromString(a)));
    const storageOut = {}; for (const [a, slots] of touched.storage) { storageOut[a] = {}; for (const s of slots) storageOut[a][s] = bytesToHex(await sm.getStorage(createAddressFromString(a), hexToBytes(s))); }
    const remote = sm.remote ? { accounts: Object.fromEntries([...sm.remote.accounts].map(([a, acct]) => [a, acct ? { nonce: hex(acct.nonce), balance: hex(acct.balance), codeHash: bytesToHex(acct.codeHash) } : null])), code: Object.fromEntries([...sm.remote.code].map(([a, c]) => [a, bytesToHex(c)])), storage: Object.fromEntries([...sm.remote.storage].map(([k, v]) => [k, bytesToHex(v)])) } : undefined;
    return { version: 1, chainId, savedAt: Date.now(), state: { accounts: accountsOut, code: codeOut, storage: storageOut }, remote,
      // tx bodies: only the most recent blocks' worth (like a pruned node), and without their logs (rebuilt from block logs on load)
      chain: { blocks: blocks.map(serBlock), txs: Object.fromEntries([...txs].filter(([, t]) => !t.receipt || hexToBigInt(t.receipt.blockNumber) >= keepFrom).map(([h, t]) => [h, { rpc: t.rpc, receipt: t.receipt ? { ...t.receipt, logs: undefined } : null, error: t.error }])), timeOffset: hex(timeOffset), baseFee: hex(baseFee), mining, impersonated: [...impersonated], dealtSlots: Object.fromEntries(dealtSlots) },
      journal: { entries: journal, timestamps: blocks.slice(1).map((b) => hex(b.timestamp)) } };
  }
  async function seedState({ accounts: accs = {}, code = {}, storage = {} }) {
    for (const [a, c] of Object.entries(code)) await sm.putCode(createAddressFromString(a), hexToBytes(c));
    for (const [a, acct] of Object.entries(accs)) { const addr = createAddressFromString(a); if (!acct) { await sm.deleteAccount(addr); continue; } await sm.putAccount(addr, new Account(hexToBigInt(acct.nonce), hexToBigInt(acct.balance), undefined, hexToBytes(acct.codeHash))); }
    for (const [a, slots] of Object.entries(storage)) for (const [k, v] of Object.entries(slots)) await sm.putStorage(createAddressFromString(a), hexToBytes(k), hexToBytes(v));
  }
  async function loadState(dump) {
    if (dump.remote) { // fork fixture: seed remote reads first so no network is needed
      await seedState({ accounts: dump.remote.accounts, code: dump.remote.code });
      for (const [k, v] of Object.entries(dump.remote.storage)) { const [a, slot] = k.split('_'); await sm.putStorage(createAddressFromString(a), hexToBytes(slot), hexToBytes(v)); }
    }
    await seedState(dump.state);
    blocks.length = 0; for (const b of dump.chain.blocks) blocks.push(deserBlock(b));
    txs.clear(); for (const [h, t] of Object.entries(dump.chain.txs)) { if (t.receipt) t.receipt.logs = []; txs.set(h, t); }
    for (const b of blocks) for (const l of b.logs) { const t = txs.get(l.transactionHash); if (t?.receipt) t.receipt.logs.push(l); }
    timeOffset = hexToBigInt(dump.chain.timeOffset); baseFee = hexToBigInt(dump.chain.baseFee); mining = dump.chain.mining;
    impersonated.clear(); for (const a of dump.chain.impersonated) impersonated.add(a);
    dealtSlots.clear(); for (const [k, v] of Object.entries(dump.chain.dealtSlots ?? {})) dealtSlots.set(k, v);
    journal.length = 0; journal.push(...(dump.journal?.entries ?? []));
  }
  /** Re-execute a recorded journal (e.g. after recompiling contracts) with the original block timestamps. */
  async function replayJournal(j) {
    recording = false; tsQueue.push(...(j.timestamps ?? []).map(hexToBigInt));
    try { for (const e of j.entries) await dispatch(e); } finally { recording = true; tsQueue.length = 0; }
  }
  function schedulePersist() {
    if (!persister) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => exclusive(async () => persister.setItem(persistKey, JSON.stringify(await dumpState()))).catch((e) => console.warn('terrarium persist failed', e)), opts.persist?.debounceMs ?? 50);
  }
  let restoredFromPersistence = false;
  if (opts.persist) {
    persister = opts.persist.storage; persistKey = opts.persist.key ?? `terrarium:${chainId}`;
    const saved = await persister.getItem(persistKey);
    if (saved) { await loadState(typeof saved === 'string' ? JSON.parse(saved) : saved); restoredFromPersistence = true; }
  }
  if (!restoredFromPersistence && opts.restore) await loadState(opts.restore);   // a recorded fixture as the baseline

  // ---- public sim API (what a test / storybook / dev toolbar would use) ------------------------
  const sim = {
    provider: eip1193, node: nodeProvider, stateManager: sm, accounts, chainId, seed, random, wallet: walletKnobs, engine, stats, restoredFromPersistence,
    /** offline fork mode: every state read the fixture could not answer (empty when the fixture is complete) */
    get offlineMisses() { return sm.misses ? sm.misses.slice() : []; },
    /** Register a scenario-level RPC method (e.g. terrarium_bot) so a dev bar can drive it through the provider alone. */
    addMethod(name, fn) { extensions.set(name, fn); },
    now: () => now(),
    mine: (n) => exclusive(() => mine(n)), snapshot: () => exclusive(snapshot), revert: (id) => exclusive(() => revertTo(id)), followChain, stop,
    /** Fabricate state. `deal` works on ANY ERC20 (slot discovery by recording SLOADs); `setState` uses your artifact's storageLayout. */
    deal: (token, holder, amount, o) => eip1193.request({ method: 'sim_deal', params: [token, holder, hex(amount), o] }),          // via RPC so it lands in the journal
    setState: (address, layout, values) => eip1193.request({ method: 'sim_setState', params: [address, layout, JSON.parse(JSON.stringify(values, (_, v) => (typeof v === 'bigint' ? hex(v) : v)))] }),
    slotFromLayout,
    /** Persistence: dump the diff (+ fork fixture), restore, or replay the journal onto new bytecode. */
    dumpState: () => exclusive(dumpState), loadState: (d) => exclusive(() => loadState(d)), replayJournal: (j) => exclusive(() => replayJournal(j)),
    get journal() { return journal.slice(); }, flush: () => { clearTimeout(persistTimer); return persister ? exclusive(async () => persister.setItem(persistKey, JSON.stringify(await dumpState()))) : Promise.resolve(); },
    get blockNumber() { return latest().number; },
    /** React to on-chain events with scripted actors (keepers, oracles, other users, bridges...). */
    onLog(filter, handler) { const l = { filter, handler }; logListeners.push(l); return () => logListeners.splice(logListeners.indexOf(l), 1); },
    /** Cheat: send a tx "from" any address without keys (impersonation), e.g. to simulate another user. */
    async sendAs(from, tx) { if (!impersonated.has(from.toLowerCase())) await eip1193.request({ method: 'anvil_impersonateAccount', params: [from] }); return eip1193.request({ method: 'eth_sendTransaction', params: [{ ...tx, from }] }); },
    /** Announce as an EIP-6963 wallet so any dapp's connect modal lists "Sim Wallet" — zero app changes. */
    announce(win = globalThis.window) {
      if (!win) return;
      const detail = Object.freeze({ info: { uuid: '7e44a1c0-5f0b-4c1e-9b7a-a1b2c3d4e5f6', name: 'Terrarium Wallet', icon: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1F6F5C"/><path d="M9 21c0-4 3-8 7-8s7 4 7 8" fill="none" stroke="#E8C547" stroke-width="2.5" stroke-linecap="round"/><circle cx="16" cy="11" r="2.5" fill="#E8C547"/></svg>'), rdns: 'dev.terrarium' }, provider: eip1193 });
      const announce = () => win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
      win.addEventListener('eip6963:requestProvider', announce);
      announce();
    },
  };
  return sim;
}
