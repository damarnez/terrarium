# Terrarium API reference

## `createTerrarium(options)` → `sim`  (`terrarium` / `terrarium/engine`)

| option | default | meaning |
|---|---|---|
| `chainId` | `31337` | chain id reported by `eth_chainId` and used for signing |
| `hardfork` | `cancun` | EVM rules (`@ethereumjs/common` Hardfork name) |
| `engine` | `'js'` (engine) / `'revm'` (scenarios) | `'revm'`: revm compiled to WebAssembly (package `terrarium-evm`). `'js'`: `@ethereumjs/vm`. Same results, see `test:uniswap` |
| `revm` | auto | `{ module?, wasm? }`: a preloaded `terrarium-evm` module and/or the wasm bytes; by default the module is imported and the wasm resolved next to it |
| `state` | `'merkle'` | `'merkle'`: Merkle Patricia trie state, real `stateRoot` in every header. `'simple'`: flat maps, slightly faster, placeholder root |
| `stateRoot` | zero | the placeholder `stateRoot` reported when no trie exists (`state: 'simple'` and fork mode) |
| `keys` | the 10 Anvil keys | accounts the wallet controls, each funded with 10,000 ETH |
| `impersonateAll` | `false` | allow `eth_sendTransaction` from any address without a key |
| `baseFeePerGas` | 1 gwei | fixed base fee |
| `blockGasLimit` | 30,000,000 | block gas limit |
| `mining` | `{ mode: 'auto' }` | `auto` (a block per tx), `manual`, `interval` (see `evm_setIntervalMining`) |
| `gasEstimation` | `'exact'` | `'exact'`: geth-style estimation against the pending block. `'fast'`: block gas limit, no estimation (CI) |
| `clock` | `() => Math.floor(Date.now()/1000)` | seconds source for block timestamps (inject a fixed clock in tests) |
| `seed` | random | seed for `sim.random()` |
| `wallet` | `{ rejectNext: 0, latencyMs: 0, receiptLagMs: 0 }` | wallet realism knobs, see `terrarium_setWallet` |
| `persist` | none | `{ storage, key?, debounceMs?, maxTxBlocks? }`; `storage` has async `getItem/setItem` (`indexedDBStorage()`, `localStorage`) |
| `restore` | none | a dump from `sim.dumpState()` to start from |
| `fork` | none | `{ url, blockNumber }`: read remote state lazily from a node; every read is recorded into the dump |
| `methods` | `{}` | extra RPC methods `{ name: (...params) => result }` |

### `sim`
| member | what |
|---|---|
| `provider` | EIP-1193 wallet provider: node methods + accounts + signing + cheatcodes |
| `node` | the same chain as a node RPC: `eth_accounts` is `[]`, wallet methods throw 4100 |
| `accounts` | viem local accounts for `keys` |
| `vm` | the `@ethereumjs/vm` instance (escape hatch; never call `runTx` outside the lock) |
| `chainId`, `seed`, `random()`, `now()`, `blockNumber` | as named; `now()` is the chain clock in seconds (bigint) |
| `engine`, `stats` | the active engine; for revm `{ runs, rounds, wasmMs }` (rounds > runs means state was fetched and re-run) |
| `wallet` | the live wallet knobs object |
| `mine(n)`, `snapshot()`, `revert(id)` | mining and snapshots (snapshots roll back blocks, receipts, journal, filters, dump) |
| `deal(token, holder, amount, { adjustTotalSupply })` | set any ERC20 balance (slot found by watching SLOADs; proxies work) |
| `setState(address, storageLayout, { variable: value, mapping: { key: value } })` | write your contract's storage by variable name |
| `slotFromLayout(layout, path)` | compute a slot from a solc storageLayout |
| `sendAs(from, tx)` | send a tx from any address (impersonation) |
| `mockContract(address, abi, handlers)` | JS handlers answer calls to that address (`handlers[fn](...args)`; throw to revert) |
| `onLog(filter, handler)` | run a handler after a block with a matching log (actors) |
| `addMethod(name, fn)` | register an RPC method at runtime |
| `dumpState()`, `loadState(dump)`, `replayJournal(journal)`, `journal`, `flush()` | persistence |
| `followChain(url, { pollMs, onBlock })`, `stop()` | mirror a live chain's block numbers; stop timers and persistence |
| `announce(window)` | announce as an EIP-6963 wallet (the injected layer does this for you) |

### `indexedDBStorage(dbName = 'terrarium', store = 'kv')`
Async `getItem/setItem/removeItem/clear` backed by IndexedDB. Works in Workers. Use as `persist.storage`.

### Verifiable blocks
Every header is sealed for real: `transactionsRoot` is the trie of the block's RLP-encoded txs, `receiptsRoot` the trie of
EIP-2718 receipts, `logsBloom` the OR of the receipts' blooms, `stateRoot` the Merkle trie root (merkle mode), and `hash` is
keccak of that header. Impersonated txs carry an Anvil-style fake signature (r = sender), so they hash and RLP like any
other tx. `test/uniswap-v2.mjs` recomputes all four from the RPC output for every block, on the Terrarium and on Anvil.

## RPC surface (`provider.request({ method, params })`)
- **Node**: `eth_chainId net_version web3_clientVersion eth_syncing eth_blockNumber eth_getBlockByNumber eth_getBlockByHash eth_getBalance eth_getTransactionCount eth_getCode eth_getStorageAt eth_gasPrice eth_maxPriorityFeePerGas eth_feeHistory eth_call eth_estimateGas eth_sendRawTransaction eth_getTransactionReceipt eth_getTransactionByHash eth_getLogs eth_newFilter eth_newBlockFilter eth_newPendingTransactionFilter eth_getFilterChanges eth_getFilterLogs eth_uninstallFilter eth_subscribe eth_unsubscribe`. `eth_call` accepts a geth state-override set as the third param; the `pending` tag simulates on the next block, and
  `eth_getBlockByNumber('pending')` returns the next block (real number and timestamp, `hash: null`) like geth/Anvil.
- **Wallet**: `eth_accounts eth_requestAccounts eth_sendTransaction personal_sign eth_signTypedData_v4 wallet_switchEthereumChain wallet_addEthereumChain wallet_getPermissions wallet_requestPermissions wallet_revokePermissions`. Wallet methods pass through the latency / rejection gate.
- **Cheatcodes** (Anvil and Hardhat names): `evm_mine anvil_mine hardhat_mine evm_setNextBlockTimestamp evm_increaseTime evm_setAutomine evm_setIntervalMining anvil_setBalance anvil_setCode anvil_setNonce anvil_setStorageAt anvil_impersonateAccount anvil_stopImpersonatingAccount anvil_setNextBlockBaseFeePerGas evm_snapshot evm_revert`.
- **Terrarium**: `sim_deal(token, holder, amountHex, opts)`, `sim_setState(address, layout, values)`, `sim_dumpState()`, `terrarium_setWallet({ rejectNext?, latencyMs?, receiptLagMs? })`, `terrarium_getWallet()`.
- **Scenario runtime** (when run through `runScenario`): `terrarium_actors(on?)`, `terrarium_status()` → `{ chainId, block, accounts, actors, actorsLabel, wallet, ...status() }`, `terrarium_reset()`, plus anything in `methods`.
- Errors carry EIP-1193 / JSON-RPC codes: `3` execution reverted (with revert `data`), `4001` user rejected, `4100` unauthorized, `4902` unknown chain, `-32601` unknown method. viem decodes them unchanged.

## `defineScenario(config)`  (`terrarium/scenario`)
| field | meaning |
|---|---|
| `chainId`, `seed`, `hardfork`, `engine` (default `'revm'`), `state`, `gasEstimation`, `wallet` | passed to `createTerrarium` |
| `persist` | IndexedDB key (default `'default'`), or `false` for in-memory |
| `setup(ctx)` | runs on every boot. `ctx.fresh` is true only when the chain has no blocks yet |
| `actors` | `{ name?, every?: ms, on?: filter \| (ctx) => filter, run(ctx, log?) }[]`; toggled together, off by default, persisted |
| `actorsLabel` | dev bar label for the toggle |
| `status(ctx)` | extra fields merged into `terrarium_status` |
| `methods` | `{ terrarium_x: (ctx, ...args) => result }` |

`ctx`: `sim`, `chainId`, `accounts`, `rpc(method, params)`, `pub` (viem public client), `wallet(account)` (viem wallet
client signing with the sim's keys), `wait(hashOrPromise)`, `deadline(seconds = 3600)` (chain clock), `random()`,
`fresh`, `codeAt(address)`, `install(fixture)`, `state` (free-form bag).

## Vite plugin  (`terrarium/vite`)
`terrarium({ scenario?: 'terrarium.scenario.ts' })`. Generates `.terrarium/{inject,worker}.ts` (gitignore it) and
injects one module script into `index.html`. Disabled when `VITE_TERRARIUM=off` (env file or environment).

## CLI  (`npx terrarium`)
- `terrarium build [--scenario file] [--out dir]`: one injectable classic script, Worker bundle embedded.
- `terrarium fetch-code <name=0xaddress>... --rpc <url> [--out fixture.json]`: runtime bytecode fixture for `ctx.install`.

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
  node would refuse (nonce, funds).
- `host`: `{ account(address) → null | { balance, nonce, codeHash, code }, storage(address, slot) → 32-byte hex,
  blockHash(number) → hex }`, all synchronous. The engine's implementation is the state mirror in `engine.js`.
- `version()`. `smoke.mjs` in the package is a minimal Node example (deploy PEPE, call, SLOAD trace).
- Build: `npm run build:wasm` = `cargo build --release --target wasm32-unknown-unknown && wasm-bindgen --target web --out-dir pkg`.

## Injected page globals
`window.terrarium = { provider, request(method, params) }`: the wallet's own global, like `window.ethereum`. For tests
and the console, never for the dapp. The dev bar mounts as `#terrarium-devbar` with `data-testid`s: `block mine
plus-hour mining snapshot actors reject-next wallet-latency receipt-lag reset`.
