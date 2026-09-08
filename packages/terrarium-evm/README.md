# @terrariumlabs/evm

```sh
npm install @terrariumlabs/evm      # you rarely install it directly: @terrariumlabs/core depends on it
```

[revm](https://github.com/bluealloy/revm) 43 compiled to WebAssembly, as the execution engine of Terrarium. About 1.29 MB
of wasm, no C dependencies (k256 for secp256k1, arkworks for bn254/bls12-381, pure-Rust KZG), built with wasm-bindgen
`--target web`. `pkg/` is committed so JavaScript users need no Rust toolchain.

## What it does, and only that
It executes transactions, and nothing more. Everything else stays in JavaScript: accounts, code and storage, checkpoints and
reverts, blocks and receipts, persistence and fork recording. The engine asks the host for whatever it reads and hands back a
state diff for the host to apply.

There are two entry points. `run(host, request)` executes one transaction and returns its state diff. `estimate(host,
request)` runs reth's gas estimation in a single call: one run at the gas cap, the optimistic 64/63 probe, then a bisection
that starts from about three times the gas used and stops within 1.5 percent. The runs share a read cache and commit nothing,
so the host is asked about each account and slot once. Analysed bytecode is cached by code hash across calls, which is why
`host.account(address, wantCode)` may omit `code` when `wantCode` is false. Never answer `'0x'` for a contract, because the
engine would read that as "no code". The module is built with `wasm-opt -O3` and `panic = "abort"`, and weighs 1.29 MB, or
463 KB gzipped.

```js
import init, { run, estimate, version } from '@terrariumlabs/evm';
await init({ module_or_path: wasmBytesOrUrl });
const result = JSON.parse(run(host, JSON.stringify({ tx, block, cfg })));
// result: { success, reason, gasUsed, gasRefunded, output, created, logs, state, sloads }
```
`host` is a plain object with the synchronous methods `account(address, wantCode)`, `storage(address, slot)` and
`blockHash(number)`. If the host cannot answer synchronously, it throws `{ missing: true }`. `run` then throws `"missing"`,
the caller loads the state and calls again, and because reads are recorded the re-run is exact. Setting `cfg.traceSloads`
makes the result list every SLOAD as an address and slot pair, which is how Terrarium's `deal` finds a token's balance slot.
The field-by-field schema is in [docs/api.md](../../docs/api.md).

## Build
```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli          # 0.2.127 at the time of writing; must match the wasm-bindgen crate version
brew install binaryen                   # wasm-opt, the last step of the build
npm run build                           # cargo build --release --target wasm32-unknown-unknown && wasm-bindgen --target web --out-dir pkg
node smoke.mjs                          # deploy PEPE, call balanceOf, trace the balance slot — PASS
```
`getrandom` is pinned with its `js` feature: wasm32-unknown-unknown has no OS entropy source.

## Fidelity and speed
`npm run test:uniswap` (repo root) runs a 14-transaction Uniswap V2 scenario on this engine and on Anvil: every
transaction hash, receipt, log, call result and revert payload is byte-identical, every block's header hash and roots
recompute from the RPC output. The scenario takes about 110 ms here (about 25 ms inside the wasm, gas estimation included) versus 75 to 100 ms on native Anvil.
`test/unit/wasm.test.mjs` pins the `run` / `host` contract described above. Since terrarium 0.3 this is the only
execution engine.
