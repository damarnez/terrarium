# Terrarium — project context for Claude Code

Read HANDOFF.md first for the full story. This file is the short operating manual.

## What this is
- **Terrarium** (`packages/terrarium/src/engine.js`): a self-contained EVM chain exposed as an EIP-1193 provider. One
  execution engine: revm 43 compiled to WebAssembly (`packages/terrarium-evm`, Rust + wasm-bindgen). The `@ethereumjs/vm`
  engine was removed in 0.3; the remaining `@ethereumjs/*` packages provide state (Merkle trie, fork RPC state manager),
  RLP, transactions and block headers. revm reads through a sync, checkpoint-aware state mirror (miss => zero/non-existent
  locally, fetch + re-run in fork mode). Blocks are sealed with real tx/receipt tries, bloom (own implementation) and
  (merkle mode) stateRoot. Blocks, receipts, logs, filters, Anvil/Hardhat cheatcodes, event-reactive actors,
  wallet-realism knobs (rejection / latency / receipt lag), a read-only `node` provider, injectable clock + seeded PRNG,
  persistence (IndexedDB / any getItem-setItem store), journal replay, snapshots that roll back everything, fork mode
  with offline fixtures, live block following. No JS-mocked contracts: mock with bytecode (`anvil_setCode` + `setState`).
- **The library** (`packages/terrarium`, npm workspace, imported as `terrarium/*`): `scenario.ts` (`defineScenario`
  + types), `worker-runtime.ts` (`runScenario`: boots the engine in a **Worker**, runs setup, wires actors, exposes
  `terrarium_actors/status/reset/httpRoutes/http`), `http.ts` (scenario `http` routes: page-side `fetch` interceptor,
  GraphQL parser, Worker-side dispatch; the dapp's subgraph / API calls answered from the chain), `bridge.ts` +
  `inject.ts` (postMessage bridge, EIP-6963 "Terrarium Wallet", `window.terrarium`, installs the interceptor), `devbar.ts` (plain-DOM overlay), `vite-plugin.ts` (generates `.terrarium/{inject,worker}.ts`
  and injects one script), `bin/terrarium.mjs` (CLI: `build` standalone bundle, `fetch-code` bytecode fixtures at
  `--block`/`--chain`, `record` = fork a chain at a block + run a warm-up script + dump an offline fixture, self-verified),
  `fixtures/uniswap-v2-mainnet.json`.
- **The example scenario** (`terrarium.scenario.ts` at the root): installs the REAL Uniswap V2 at the mainnet
  addresses, deploys PEPE, seeds the pair, declares the bot-frog actors, and answers the Uniswap V2 subgraph URL the
  dapp is configured with (`VITE_SUBGRAPH_URL`) from the chain's logs, with `Indexer: down / behind / live` controls.
- **Frogpond** (`src/`): an ordinary dapp on Uniswap V2 (Router02 / Pair ABIs in `src/lib/uniswap.ts`). Configured by
  `.env`: chain id, router address, token address, optional read RPC, subgraph URL (`src/lib/useIndexer.ts` +
  `src/components/Indexer.tsx` query it with plain fetch + GraphQL). Vite + React 19 + TypeScript + viem 2.
- **Contracts** (`contracts/PEPE.sol`), compiled by `scripts/build-contracts.mjs [dir] [out.ts]` into `src/generated/contracts.ts`.
- **Examples** (`examples/aave`, `examples/euler`, npm workspaces): each is a recorded mainnet fork (`record.mjs` →
  `fixtures/*.json`), an offline scenario (`fork: { offline: true }, restore, clock: 'recording'`), an ordinary dapp
  (`src/`, `.env` addresses) and an offline replay test (`test.mjs`). Aave adds `contracts/FixedPriceFeed.sol` +
  `terrarium_ethPrice` + dev-bar `controls`.

## Commands
```
npm install
npm run build:contracts      # Solidity -> src/generated/contracts.ts (+ contracts/out/*.json)
npm run dev                  # http://localhost:5173  -> Connect wallet -> Terrarium Wallet
npm run typecheck
npm run build                # dapp WITH the terrarium injected (demo mode); VITE_TERRARIUM=off npm run build = plain dapp
npm run build:terrarium      # = npx terrarium build: standalone injectable dist-terrarium/terrarium.js
npx terrarium fetch-code name=0x… --rpc URL [--block N] [--chain ID] --out f.json   # runtime bytecode fixture for ctx.install
npx terrarium record name=0x… --rpc URL --block N --chain ID [--script warm.mjs] --out f.json   # state at a block as an offline fork fixture
npm run e2e:install          # once: Chromium for Playwright
npm run e2e                  # plain build + injected terrarium, whole flow in headless Chromium (JSON + PASS/FAIL)
npm test                     # test:unit + test:fork + test:examples (no network, no Foundry, no browser)
npm run test:unit            # node --test test/unit/*.test.mjs: engine, wasm, scenario runtime, bridge, vite plugin, CLI
npm run test:uniswap         # real Uniswap V2 in the Terrarium vs Anvil: byte-identical receipts + RPC parity (needs Foundry)
npm run test:fork            # offline replay of the recorded mainnet fork fixture (test/fixtures/); test:fork:record re-records
npm run example:aave / example:euler   # the two protocol examples (ports 5174 / 5175); record:aave / record:euler re-record their fixtures (network)
npm run test:examples        # offline replays of both examples
npm run build:wasm           # rebuild packages/terrarium-evm/pkg (Rust: wasm32-unknown-unknown target + wasm-bindgen-cli 0.2.127); pkg is committed
```

## Hard rules (keep these)
1. **The dapp never imports or references the simulator.** `src/**` uses viem + EIP-6963 discovery + `.env` only.
   No `window.terrarium`, no rdns special-casing, no dev bar component. Its off-chain reads are plain `fetch` to URLs
   from `.env`; the interception lives in `inject.ts` / `http.ts`, never in `src/`. Scenario code lives in `terrarium.scenario.ts`. The e2e runs the `VITE_TERRARIUM=off` build
   and asserts no simulator chunk exists; keep it that way.
2. **Change EVM state, never RPC responses.** Fake balances go in via `sim.deal`, `sim.setState`, cheatcodes or real
   impersonated transactions, never by rewriting `eth_call` results. HTTP routes answer *off-chain* endpoints (subgraphs,
   APIs) from the chain; they must never match the dapp's RPC URL.
3. **Every state mutation goes through the RPC layer** (`handle()` in `packages/terrarium/src/engine.js`) so it lands in the journal
   and persistence. Scenario controls are `terrarium_*` RPC methods (`sim.addMethod`), not side channels.
4. **All state-touching work is serialized** through the single `exclusive()` queue. Never call `mine()`, `runTx`,
   `checkpoint/revert` from outside it. Wallet latency/rejection run in the gate *before* the lock on purpose.
5. Contract changes: edit `contracts/*.sol`, run `npm run build:contracts`, never hand-edit `src/generated/`.
6. Fidelity claims must be backed by `npm run test:uniswap` (differential vs Anvil, verifiable blocks, RPC parity). If you
   touch tx execution, gas, blocks, receipts, logs, revert data or the state mirror, run it. Everything else has a unit
   test in `test/unit/`: add one with the change (`npm test` must stay green without network, Foundry or a browser).
7. RPC errors thrown to viem must extend viem's `BaseError` (`RpcError` in the engine, `ProviderRpcError` in the bridge):
   a foreign error with an unknown code is wrapped as "unknown" and retried 3× with backoff (1 s per reverted estimate).
8. Rust changes: `npm run build:wasm` regenerates `packages/terrarium-evm/pkg` (committed, so JS-only users need no Rust).

## Known gotchas (already handled in packages/terrarium/src/engine.js — do not "clean up" these)
- `@ethereumjs/statemanager` 10.1.3 `RPCStateManager.commit()` only commits the *account* cache → subclass commits all.
- Fork reads fetched under a checkpoint (every `eth_call`) are dropped from the state manager's cache on revert; the
  recording (`remote`) serves them afterwards, since remote state at a fixed block never changes.
- Vite does not polyfill `process`; ethereumjs depends on `debug`, which reads `process.env.DEBUG` in the browser → every
  host `vite.config.ts` needs the `define` block (see the tutorial). The CLI build sets it itself.
- `ctx.fresh` is never true in fork mode (the chain starts at fork block + 1): fixture scenarios seed with `ctx.firstBoot`.
- `terrarium_reset` clears the whole IndexedDB store of the origin, not one key.
- Relative imports inside `packages/terrarium/src` carry their `.ts` extension so Node can load the runtime in tests.
- **Gas is estimated against the *pending* block** (`pendingBlock()`), like geth. Estimating against `latest` made
  real Uniswap swaps run out of gas: the pair's price accumulators cost more when block.timestamp has advanced.
- Gas estimation is geth-style (full simulated tx, 64/63 probe, binary search); `gasEstimation: 'fast'` skips it.
- Filter cursors resolve block tags beyond `latest` numerically, and are clamped on snapshot revert.
- `deadline` params come from the chain's clock: `sim.now()` in scenarios, the **pending** block's timestamp in the dapp
  (`getBlock({ blockTag: 'pending' })`). Never `Date.now()` (the dev bar shifts time) and never `latest` (an idle chain's
  latest block can be hours old: real Uniswap answered `EXPIRED` after an hour without trades).
- Dropped (invalid) txs get a failed receipt so `waitForTransactionReceipt` never hangs.
- viem's `watchBlockNumber` ignores a head moving backwards; the dapp polls the head itself and reloads history when
  the number drops or the hash changes (`usePond.ts`).
- Uniswap's `Swap.to` for token→ETH swaps is the router; the dapp resolves the tx sender for attribution.
- Snapshots must capture the chain clock (`timeOffset`, `nextTimestamp`, `baseFee`): a recorder that time-travels and
  reverts otherwise bakes the offset into the fixture.
- Fork fixtures: a known-absent account answers code/storage locally (the two engines ask different questions about the
  same address). Time travel past an oracle's heartbeat reverts with staleness errors (Euler); that is correct behaviour.
- Fixture-backed scenarios key `persist` by the fixture's block number, or a re-recorded fixture never loads.
- HTTP routes are posted to the page (`{ event: 'httpRoutes' }`) *before* the chain boots so the dapp's first fetches are
  not held by `setup()`; `terrarium_httpRoutes` is the fallback. Handlers run outside the state lock (extension methods).
  Only `fetch` is intercepted; a throwing handler answers 500 + console warning, never a thrown TypeError.

## Where things are
- Docs index: `docs/README.md`. Tutorial: `docs/tutorial-new-protocol.md` (project anatomy, the three sources of bytes, compiling contracts, CLI recipes, off-chain data step).
  `docs/http-and-subgraphs.md` (HTTP routes guide), `docs/cookbook.md` (every feature, one example). API reference (all options, sim members, RPC methods, scenario config,
  plugin, CLI, HTTP routes): `docs/api.md`. Keep all of them in sync with `packages/terrarium/src`; a new feature gets a cookbook recipe and an api.md row.
- Engine API reference: `docs/design-investigation.md` Appendix A; state/persistence chapter §4b.
- E2E expectations and numbers: `e2e/frogpond.e2e.mjs`. Unit suite: `test/unit/` (`helpers.mjs` boots a sim with a fixed
  clock; `node --test --test-force-exit` because actor timers may outlive a test).
- Fidelity proof: `test/uniswap-v2.mjs`; fork demo: `test/fork-record.mjs`, `test/fork-offline.mjs`.
- Test accounts: the 10 Anvil keys (`TEST_KEYS`); account 0 is "you", account 9 the treasury that deploys PEPE and
  seeds the pool, accounts 6–8 the "Pond life" bot frogs. PEPE's address is deterministic (treasury nonce 0).
