# Terrarium API reference

← [Docs index](README.md) · [Tutorial](tutorial-new-protocol.md) · [Cookbook](cookbook.md) · [Off-chain data](http-and-subgraphs.md)

**Contents:** [createTerrarium](#createterrariumoptions--sim--terrarium--terrariumengine) · [sim](#sim) · [Verifiable blocks](#verifiable-blocks) ·
[RPC surface](#rpc-surface-providerrequest-method-params-) · [defineScenario](#definescenarioconfig--terrariumscenario) · [HTTP routes](#http-routes-terrariumhttp) ·
[Recording a protocol](#recording-a-protocol-the-examples-recipe) · [Vite plugin](#vite-plugin--terrariumvite) · [CLI](#cli--npx-terrarium) · [Bridge](#the-postmessage-bridge--terrariumbridge) ·
[wasm engine](#the-wasm-engine-package-terrarium-evm) · [Injected page globals](#injected-page-globals) · [Tests](#tests)

## `createTerrarium(options)` → `sim`  (`terrarium` / `terrarium/engine`)

| option | default | meaning |
|---|---|---|
| `chainId` | `31337` | chain id reported by `eth_chainId` and used for signing |
| `hardfork` | `cancun` | EVM rules (`@ethereumjs/common` Hardfork name; passed to revm as the spec) |
| `engine` | `'revm'` | the only execution engine since 0.3: revm compiled to WebAssembly (package `terrarium-evm`). Any other value throws |
| `revm` | auto | `{ module?, wasm? }`: a preloaded `terrarium-evm` module and/or the wasm bytes; by default the module is imported and the wasm resolved next to it (Node: read from disk; browser: a Vite asset or a data URL in the standalone bundle) |
| `state` | `'merkle'` | `'merkle'`: Merkle Patricia trie state, real `stateRoot` in every header. `'simple'`: flat maps, slightly faster, placeholder root |
| `stateRoot` | zero | the placeholder `stateRoot` reported when no trie exists (`state: 'simple'` and fork mode) |
| `keys` | the 10 Anvil keys | accounts the wallet controls, each funded with 10,000 ETH at genesis |
| `impersonateAll` | `false` | allow `eth_sendTransaction` from any address without a key or a prior `anvil_impersonateAccount` |
| `baseFeePerGas` | 1 gwei | base fee of every block (until `anvil_setNextBlockBaseFeePerGas`) |
| `blockGasLimit` | 30,000,000 | block gas limit; also the gas limit of `gasEstimation: 'fast'` transactions |
| `mining` | `{ mode: 'auto' }` | `auto` (a block per tx), `manual` (`evm_mine`), `interval` (`evm_setIntervalMining`), `follow` (`sim.followChain`) |
| `gasEstimation` | `'exact'` | `'exact'`: geth-style estimation against the **pending** block (full run, 64/63 probe, binary search). `'fast'`: block gas limit, no estimation (CI) |
| `clock` | `() => Math.floor(Date.now()/1000)` | seconds source for block timestamps. Blocks are at least one second apart; a fixed clock gives deterministic timestamps |
| `seed` | random | seed for `sim.random()` (mulberry32) |
| `wallet` | `{ rejectNext: 0, latencyMs: 0, receiptLagMs: 0 }` | wallet realism knobs, see `terrarium_setWallet` |
| `persist` | none | `{ storage, key?, debounceMs?, maxTxBlocks? }`; `storage` has async `getItem/setItem` (`indexedDBStorage()`, `localStorage`, anything). Default key `terrarium:<chainId>`, debounce 50 ms, tx bodies kept for the last 2000 blocks |
| `restore` | none | a dump from `sim.dumpState()` to start from; with `persist`, it is the baseline used only when nothing was persisted yet |
| `fork` | none | `{ url?, blockNumber, offline? }`: read remote state lazily from a node at `blockNumber`; every read is recorded into the dump. The local chain starts at `blockNumber + 1` (earlier blocks are not served). `offline: true`: no network; a read the fixture cannot answer throws `OfflineStateError` and is listed in `sim.offlineMisses` |
| `methods` | `{}` | extra RPC methods `{ name: (...params) => result }`, reachable through `provider` and `node` |

### `sim`
| member | what |
|---|---|
| `provider` | EIP-1193 wallet provider: node methods + accounts + signing + cheatcodes + extensions |
| `node` | the same chain as a node RPC: `eth_accounts` is `[]`, wallet methods throw 4100 |
| `accounts` | viem local accounts for `keys` |
| `stateManager` | the `@ethereumjs/statemanager` instance (escape hatch; never write through it outside the RPC layer) |
| `chainId`, `seed`, `random()`, `now()`, `blockNumber` | as named; `now()` is the chain clock in seconds (bigint, includes `evm_increaseTime`) |
| `engine`, `stats` | `'revm'`; `{ runs, rounds, wasmMs }` (rounds > runs means state was fetched on a miss and the tx re-run) |
| `wallet` | the live wallet knobs object |
| `restoredFromPersistence`, `offlineMisses` | whether the boot restored a persisted chain; `{ kind, key }[]` of reads an offline fixture could not answer |
| `mine(n)`, `snapshot()`, `revert(id)` | mining and snapshots (snapshots roll back state, blocks, receipts, journal, filter cursors, the chain clock, the base fee and the dump) |
| `deal(token, holder, amount, { adjustTotalSupply = true })` | set any ERC20 balance (slot found by watching SLOADs; proxies work; returns the slot). Throws for computed balances |
| `setState(address, storageLayout, { variable: value, mapping: { key: value } })` | write a contract's storage by variable name (values: bigint, number, boolean, hex string; nested objects for mappings). Returns `{ path, slot }[]` |
| `slotFromLayout(layout, path)` | compute a slot from a solc storageLayout: scalars, mappings (address / uint / bytes32 / string keys), dynamic arrays. Throws for packed variables |
| `sendAs(from, tx)` | send a tx from any address (impersonation; Anvil-style fake signature with `r = sender`) |
| `onLog(filter, handler)` | run `handler(log, { blockNumber })` after a block with a matching log (actors); returns an unsubscribe function |
| `addMethod(name, fn)` | register an RPC method at runtime. Extension methods run **outside** the state lock so they can call other RPC methods |
| `dumpState()`, `loadState(dump)`, `replayJournal(journal)`, `journal`, `flush()` | persistence; `journal` lists the state-changing RPC calls since boot (a replay is not re-recorded) |
| `followChain(url, { pollMs, onBlock })`, `stop()` | mirror a live chain's block numbers and timestamps; stop timers and persistence |
| `announce(window)` | announce as an EIP-6963 wallet (`rdns: 'dev.terrarium'`; the injected layer does this for you) |

### `indexedDBStorage(dbName = 'terrarium', store = 'kv')`
Async `getItem/setItem/removeItem/clear` backed by IndexedDB. Works in Workers. Use as `persist.storage`. `TEST_KEYS` (the ten
Anvil private keys) and `OfflineStateError` are exported too.

### Verifiable blocks
Every header is sealed for real: `transactionsRoot` is the trie of the block's RLP-encoded txs, `receiptsRoot` the trie of
EIP-2718 receipts, `logsBloom` the OR of the receipts' blooms, `stateRoot` the Merkle trie root (merkle mode), and `hash` is
keccak of that header. Impersonated txs carry an Anvil-style fake signature (r = sender), so they hash and RLP like any
other tx. `test/uniswap-v2.mjs` recomputes all four from the RPC output for every block, on the Terrarium and on Anvil,
with a spec-level bloom and receipt encoder independent of the engine's. A transaction a node would drop (bad nonce, no
funds) gets a failed receipt with `droppedReason` instead, so `waitForTransactionReceipt` never hangs.

## RPC surface (`provider.request({ method, params })`)
- **Node**: `eth_chainId net_version web3_clientVersion eth_syncing eth_blockNumber eth_getBlockByNumber eth_getBlockByHash eth_getBalance eth_getTransactionCount eth_getCode eth_getStorageAt eth_gasPrice eth_maxPriorityFeePerGas eth_feeHistory eth_call eth_estimateGas eth_sendRawTransaction eth_getTransactionReceipt eth_getTransactionByHash eth_getLogs eth_newFilter eth_newBlockFilter eth_newPendingTransactionFilter eth_getFilterChanges eth_getFilterLogs eth_uninstallFilter eth_subscribe eth_unsubscribe`. `eth_call` accepts a geth state-override set (`balance nonce code state stateDiff`) as the third param; the `pending` tag simulates on the next block;
  `eth_getBlockByNumber('pending')` returns the next block (real number and timestamp, `hash: null`, the mempool as `transactions`) like geth/Anvil. `eth_subscribe` answers `0x1` and new heads arrive as EIP-1193 `message` events (`{ type: 'eth_subscription', data: { subscription, result } }`); viem's `custom` transport polls anyway.
- **Wallet**: `eth_accounts eth_requestAccounts eth_sendTransaction personal_sign eth_signTypedData_v4 wallet_switchEthereumChain wallet_addEthereumChain wallet_getPermissions wallet_requestPermissions wallet_revokePermissions`. Wallet methods pass through the latency / rejection gate (before the state lock, so reads keep flowing).
- **Cheatcodes** (Anvil and Hardhat names, so viem's `createTestClient({ mode: 'anvil' })` works unchanged): `evm_mine anvil_mine hardhat_mine evm_setNextBlockTimestamp evm_increaseTime (negative allowed) evm_setAutomine evm_setIntervalMining anvil_setBalance anvil_setCode anvil_setNonce anvil_setStorageAt anvil_impersonateAccount anvil_stopImpersonatingAccount anvil_setNextBlockBaseFeePerGas evm_snapshot evm_revert`; every `anvil_*` also as `hardhat_*`, and `anvil_setNextBlockTimestamp / anvil_increaseTime / anvil_setAutomine / anvil_setIntervalMining` as aliases of the `evm_*` ones.
- **Terrarium**: `sim_deal(token, holder, amountHex, opts)`, `sim_setState(address, layout, values)`, `sim_dumpState()`, `terrarium_setWallet({ rejectNext?, latencyMs?, receiptLagMs? })` → the knobs, `terrarium_getWallet()`.
- **Scenario runtime** (when run through `runScenario`): `terrarium_actors(on?)` → enabled, `terrarium_status()` → `{ chainId, engine, block, accounts, actors, actorsLabel, hasActors, wallet, controls, restoredFromPersistence, localBlocks, fork: null | { blockNumber, offline, misses }, http: { routes, hits }, ...status(ctx) }`, `terrarium_reset()` (stops actors and timers, **clears the whole IndexedDB store** of this origin, returns true; the dev bar reloads), `terrarium_httpRoutes()` → the scenario's `http` routes in wire form, `terrarium_http(index, { url, method, headers?, body? })` → `{ status, headers, body }` (runs one route; what the patched `fetch` calls), plus anything in `methods`.
- Errors carry EIP-1193 / JSON-RPC codes and extend viem's `BaseError`: `3` execution reverted (with revert `data`), `4001` user rejected, `4100` unauthorized (unknown signer, or a wallet method on `node`), `4902` unknown chain, `-32000` node errors (`no key for 0x…`, `filter not found`), `-32601` unknown method. viem decodes them unchanged and does not retry them.

## `defineScenario(config)`  (`terrarium/scenario`)
| field | meaning |
|---|---|
| `chainId`, `seed`, `hardfork`, `state`, `gasEstimation`, `wallet` | passed to `createTerrarium` |
| `persist` | IndexedDB key (default `'default'`), or `false` for in-memory. The actors' on/off state persists under `<key>:actors`. Key it by fixture (`\`aave-${fixture.blockNumber}\``) so a re-recorded fixture starts fresh |
| `fork`, `restore` | a forked chain (`{ url?, blockNumber, offline? }`) and/or a recorded dump (or an async function returning one) as the baseline. Typical offline example: `fork: { blockNumber, offline: true }, restore: fixture.dump` |
| `clock` | `'wall'` (default), `'recording'` (wall clock re-based to the fixture's last block: oracles with staleness checks keep working), or a fixed number of seconds (blocks then advance one second at a time) |
| `controls` | `{ label, method, params?, title? }[]`: extra dev-bar buttons calling your `methods` (or any RPC method) |
| `setup(ctx)` | runs on every boot. `ctx.fresh` is true only when the chain is at block 0; `ctx.firstBoot` when nothing was persisted yet |
| `actors` | `{ name?, every?: ms, on?: filter \| (ctx) => filter, run(ctx, log?) }[]`; toggled together, off by default, persisted. A throwing actor is logged (`[terrarium] actor … failed`), never fatal |
| `actorsLabel` | dev bar label for the toggle (default `Actors`) |
| `status(ctx)` | extra fields merged into `terrarium_status` |
| `methods` | `{ terrarium_x: (ctx, ...args) => result }` |
| `http` | `HttpRoute[]`: the dapp's HTTP calls to answer from the chain (see [HTTP routes](#http-routes-terrariumhttp)) |

`ctx`: `sim`, `chainId`, `accounts`, `rpc(method, params)`, `pub` (viem public client), `wallet(account)` (viem wallet
client signing with the sim's keys), `wait(hashOrPromise)`, `deadline(seconds = 3600)` (chain clock), `random()`,
`fresh` (block 0: first boot or after Reset; **never true in fork mode**, where the chain starts at the fork block + 1),
`firstBoot` (nothing persisted yet, even if a fixture was restored: the once-only hook for fork scenarios), `codeAt(address)`,
`install(fixture)` (writes each contract's code only where there is none), `state` (free-form bag).

## HTTP routes  (`terrarium/http`)
The page's `fetch` is patched by `startTerrarium`; requests matching a scenario `http` route are posted to the Worker and
answered there, everything else goes to the network. Full guide: [http-and-subgraphs.md](http-and-subgraphs.md).

| field of an `HttpRoute` | meaning |
|---|---|
| `match` | `string`: URL prefix, or glob when it contains `*`; `RegExp`: tested against the full URL |
| `method` | restrict to one HTTP method (default any) |
| `handler(ctx, req)` | return JSON data (→ 200 `application/json`, bigints as strings), a string (→ 200 `text/plain`) or `reply(body, { status?, headers? })`. With `graphql` present: a gate, `undefined` lets the resolvers answer |
| `graphql` | `{ field: (ctx, q: GraphqlQuery) => result }`; the operation is parsed, each top-level field resolved, answered as `{ data, errors? }`; syntax errors → 400 |
| `name` | for warnings and `terrarium_httpRoutes` |

`req: HttpRequest = { url, method, headers, body: string | null, json, query }`. `q: GraphqlQuery = { field, alias, args, selection,
variables, operationName, query }` (variables substituted and defaults applied; enums as strings; fragments not expanded).
`reply` is exported from `terrarium/scenario`. `terrarium/http` also exports `parseGraphql(source, variables?, operationName?)`,
`compileMatcher(wireRoute)`, `installHttpInterceptor(provider, routesPromise, scope = globalThis)` → restore function, `runRoute(ctx, route, raw)`,
`toWire(routes)`. The Worker posts `{ event: 'httpRoutes', payload }` before booting so the page can start intercepting immediately;
a handler that throws is answered as a 500 with `{ error }` and a console warning. Only `fetch` is intercepted (not XHR or WebSocket).

### Recording a protocol (the examples' recipe)
`npx terrarium record … --script warm.mjs` does the steps below for you (the script is step 2). By hand:
1. `createTerrarium({ fork: { url, blockNumber } })` in a Node script; `deal` the user its tokens; `sim.snapshot()`.
2. Exercise every path the UI will take, including the view calls it polls and time passing: everything read is recorded.
3. `sim.revert(snapshot)` (the user's position is gone, the recordings stay), `sim.dumpState()` → fixture JSON.
4. Scenario: `fork: { blockNumber, offline: true }, restore: fixture.dump, clock: 'recording'`. A miss shows up in the dev
   bar as `N MISSES` and in `sim.offlineMisses`: warm that read in the recorder and re-record.
See `examples/aave/record.mjs` and `examples/euler/record.mjs`, and the tutorial's step 1B.

## Vite plugin  (`terrarium/vite`)
`terrarium({ scenario?: 'terrarium.scenario.ts' })`. Generates `.terrarium/{inject,worker}.ts` (gitignore it) and
injects one module script into `index.html`. Disabled when `VITE_TERRARIUM=off` (env file or environment). The host
config also needs `define: { 'process.env.DEBUG': 'undefined', 'process.env.TERRARIUM_DEBUG': 'undefined' }` (ethereumjs
depends on `debug`, which reads `process.env` in the browser), `worker: { format: 'es' }` and `build.target: 'es2022'`.

## CLI  (`npx terrarium`)
- `terrarium build [--scenario file] [--out dir]`: one injectable classic script `dist-terrarium/terrarium.js` (IIFE,
  Worker bundle and wasm embedded, ≈2.8 MB) plus `terrarium.worker.js`. Built with Vite from the cwd, so the scenario's
  `import.meta.env.VITE_*` come from the cwd's `.env` files.
- `terrarium fetch-code <name=0xaddress>... --rpc <url> [--block N] [--chain ID] [--out fixture.json]`: runtime bytecode
  fixture for `ctx.install`: `{ source, chainId, blockNumber, fetchedAt, contracts: { name: { address, code } } }`. The code is
  read at `--block` (default: the node's latest). `--chain` exits 1 if the node serves another chain; an address without
  code exits 1.
- `terrarium record [name=0xaddress]... --rpc <url> [--block N] [--chain ID] [--storage name:slot,slot]... [--script file.mjs] [--keep] [--out fixture.json]`:
  the state of a chain at a block as an offline fork fixture. Forks at `--block` (default: latest − 8) with the chain clock
  anchored to that block's timestamp, reads each named account (balance, nonce, code) and each `--storage` slot, then runs
  the script's default export `async ({ sim, pub, wallet, accounts, addresses, rpc, viem }) => expected` against the fork
  (every touched account, code blob and slot is recorded) inside a snapshot that is reverted afterwards unless `--keep`.
  Writes `{ source, chainId, blockNumber, timestamp, recordedAt, addresses, expected, remoteReads, dump }`, then boots the
  file with the network forbidden and reads the named accounts back; a fixture that cannot replay is not written (exit 1).
  Consumed by a scenario as `fork: { blockNumber: fixture.blockNumber, offline: true }, restore: fixture.dump, clock: 'recording'`.

## The postMessage bridge  (`terrarium/bridge`)
`serveProvider(provider)` (Worker side) answers `{ id, method, params }` messages and forwards `message`, `accountsChanged`,
`chainChanged`, `disconnect` events; it posts `{ event: 'ready' }` first. `createWorkerProvider(worker)` (page side) is
the EIP-1193 facade: requests made before `ready` are queued; errors come back as `ProviderRpcError` (a viem `BaseError`
with `code` and `data`). `runScenario` and `startTerrarium` use these; you only need them for a custom host.

## The wasm engine package (`terrarium-evm`)
`packages/terrarium-evm`: revm 43 compiled to `wasm32-unknown-unknown` with wasm-bindgen (`--target web`), no C
dependencies (k256 / ark / pure-Rust KZG fallbacks). `engine.js` drives it; you normally never call it directly.
- `init({ module_or_path })` (default export): instantiate; bytes, URL or Response. `engine.js` passes bytes in Node and
  lets the glue resolve `terrarium_evm_bg.wasm` next to itself in the browser (Vite asset; data URL in the standalone bundle).
- `run(host, requestJson) → resultJson`. Request: `{ tx: { from, to|null, value, data, gasLimit, gasPrice, priorityFee?,
  nonce?, txType? }, block: { number, timestamp, gasLimit, baseFee, coinbase?, prevRandao? }, cfg: { chainId, spec?,
  skipBalance?, skipNonce?, skipBlockGasLimit?, noBaseFee?, skipEip3607?, traceSloads? } }` (all numbers hex strings).
  Result: `{ success, reason, gasUsed, gasRefunded, output, created, logs: [{ address, topics, data }], state: [{ address,
  deleted, balance, nonce, codeHash, code?, storage: [[slot, value]] }], sloads: [[address, slot]] }`.
  Throws `"missing"` when the host threw `{ missing: true }` (state to fetch, then re-run) and `"invalid: ..."` for a tx a
  node would refuse (nonce, funds, `PriorityFeeGreaterThanMaxFee`).
- `host`: `{ account(address) → null | { balance, nonce, codeHash, code }, storage(address, slot) → 32-byte hex,
  blockHash(number) → hex }`, all synchronous. The engine's implementation is the state mirror in `engine.js`.
- `version()`. `smoke.mjs` in the package is a minimal Node example (deploy PEPE, call, SLOAD trace); `test/unit/wasm.test.mjs` covers the contract above.
- Build: `npm run build:wasm` = `cargo build --release --target wasm32-unknown-unknown && wasm-bindgen --target web --out-dir pkg`.

## Injected page globals
`window.terrarium = { provider, request(method, params) }`: the wallet's own global, like `window.ethereum`. For tests
and the console, never for the dapp. `window.fetch` is replaced by the HTTP interceptor when the scenario declares
`http` routes (unmatched requests pass through to the original). The dev bar mounts as `<footer id="terrarium-devbar" data-testid="devbar">` with
buttons carrying `data-testid`s: `block` (the head counter), `mine plus-hour mining snapshot actors reject-next
wallet-latency receipt-lag reset`, and `control-<i>` for the scenario's `controls` in order.

## Tests
`npm test` = `test:unit` (Node's test runner, `test/unit/*.test.mjs`, no network, no Foundry: chain, transactions,
cheatcodes, state fabrication, logs and actors, wallet, persistence, fork mode with a local fake node, the wasm engine,
the scenario runtime, HTTP routes (parser, Worker dispatch, page interceptor), the bridge, the Vite plugin, the CLI
including a standalone build) + `test:fork` + `test:examples`.
Separately: `test:uniswap` (differential vs Anvil, needs Foundry) and `e2e` (headless Chromium: the dev bar, IndexedDB
persistence and the injected wallet, which have no Node equivalent).
