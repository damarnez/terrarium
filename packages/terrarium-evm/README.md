# terrarium-evm

[revm](https://github.com/bluealloy/revm) 43 compiled to WebAssembly, as the execution engine of Terrarium. About 1.5 MB
of wasm, no C dependencies (k256 for secp256k1, arkworks for bn254/bls12-381, pure-Rust KZG), built with wasm-bindgen
`--target web`. `pkg/` is committed so JavaScript users need no Rust toolchain.

## What it does, and only that
It executes one transaction per call. Everything else stays in JavaScript: accounts, code and storage, checkpoints and
reverts, blocks and receipts, persistence, fork recording. The engine asks the host for what it reads and returns a
state diff to apply:

```js
import init, { run, version } from 'terrarium-evm';
await init({ module_or_path: wasmBytesOrUrl });
const result = JSON.parse(run(host, JSON.stringify({ tx, block, cfg })));
// result: { success, reason, gasUsed, gasRefunded, output, created, logs, state, sloads }
```
`host` is a plain object with synchronous methods `account(address)`, `storage(address, slot)`, `blockHash(number)`.
If the host cannot answer synchronously it throws `{ missing: true }`; `run` throws `"missing"`, the caller loads the
state and calls again. Reads are recorded, so re-runs are exact. `cfg.traceSloads` returns every SLOAD (address, slot)
— how Terrarium's `deal` finds a token's balance slot. Field-by-field schema: [docs/api.md](../../docs/api.md).

## Build
```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli          # 0.2.127 at the time of writing; must match the wasm-bindgen crate version
npm run build                           # cargo build --release --target wasm32-unknown-unknown && wasm-bindgen --target web --out-dir pkg
node smoke.mjs                          # deploy PEPE, call balanceOf, trace the balance slot — PASS
```
`getrandom` is pinned with its `js` feature: wasm32-unknown-unknown has no OS entropy source.

## Fidelity and speed
`npm run test:uniswap` (repo root) runs a 14-transaction Uniswap V2 scenario on this engine, on the `@ethereumjs/vm`
engine and on Anvil: every transaction hash, receipt, log, call result and revert payload is byte-identical, every
block's header hash and roots recompute from the RPC output. The scenario takes ≈110 ms here (≈25 ms inside the wasm)
versus ≈350 ms on the JavaScript engine and ≈50 ms on native Anvil.
