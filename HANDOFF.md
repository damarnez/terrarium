# Handoff — how this project came to be, what is proven, what is next

Written 2 Sep 2026 at the end of a design conversation, extended pass by pass since. Target location on Daniel's Mac:
`/Users/daniel/Work/personal/terrarium`.

## 1. The original idea (Daniel)
Solidity contracts are painful to test from the frontend. Idea: "transpile" the contract logic into something the
frontend can run locally (WASM), so the UI can talk to it like a real chain — block numbers, real-looking
transactions/receipts, events the frontend can subscribe to, other parties' responses mocked, external contracts
either forked over RPC or mocked, block numbers following the connected chain. Must be small and easy: build the
artifact from the Solidity, move it to the front, done.

## 2. What the investigation concluded (full text: docs/design-investigation.md)
- **Don't transpile Solidity to WASM.** Compile with solc as usual and run the *EVM bytecode* in an EVM that lives in
  the browser. Fidelity is byte-identical (ABI, revert data/custom errors, events, gas, addresses), external
  contracts can be forked, and the artifact stays the normal Foundry/Hardhat one. Solidity removed its own EWasm
  backend in 0.8.21 (2023).
- **Engine:** `@ethereumjs/*` v10 (TypeScript, browser-first, controlled deps, hardforks up to Amsterdam).
  WASM EVMs exist (Guillotine/Zig ≈110 KB claimed, alpha; revm→wasm possible) but a sync WASM interpreter needs
  JSPI/Asyncify for lazy fork state (JSPI: Chrome/Firefox yes, Safari not yet). Engine is behind a small interface
  so it can be swapped later.
- **Integration surface:** EIP-1193 provider + EIP-6963 announcement → the dapp's existing connect modal simply
  shows "Terrarium Wallet"; wagmi/viem/ethers/RainbowKit need zero code changes. Also usable as a viem
  `custom()` transport, in Node/Vitest, in Playwright via `addInitScript`.
- **Closest prior art: Tevm** (same idea; fork, mining, viem/Anvil actions, `import './X.sol'`). Evaluated and not
  adopted as a dependency: both published channels failed to import on a fresh install (inter-package version
  drift: `1.0.0-rc.153` and `2.0.0-next.107`), bundle 1.75 MB / 449 KB gz (3× ours, mostly zod + all viem chains),
  engine being rewritten. Decision: own a thin layer on ethereumjs, borrow ideas (MIT).
- **Measured:** simulator bundle 572 KB min / 173 KB gzip incl. viem utils (dev-only chunk); boot ~60 ms in
  Chromium; ~8 ms per `writeContract` end to end (with geth-style gas estimation); 0.5 ms per `eth_call`.

## 3. State & persistence (design §4b) — the follow-up question
- The artifact is code; state lives in the simulator's state manager. Two persistence mechanisms, both implemented:
  **state dump** (diff of touched accounts/code/slots + blocks/receipts/logs; `persist: { storage: localStorage }`
  auto-saves, 57 KB for the vault scenario, restore ≈150 ms) and **journal replay** (state-changing RPC calls +
  block timestamps; replays onto fresh or *recompiled* bytecode with identical block hashes).
- Fabricating state — safest to sharpest: real txs with impersonation → `sim.deal(token, user, amount)` (finds the
  ERC20 balance slot by recording SLOADs; works through proxies, verified on real mainnet USDC) → `sim.setState`
  by variable name via storageLayout → raw `anvil_setStorageAt/setCode` → `eth_call` `stateOverride` for what-if
  reads. Rule: leaf state can be written; structural state (pool reserves, LP totals, V3 positions) must be produced
  by real transactions after dealing the inputs.
- Fork mode records every remote read → the dump is an offline fixture (verified: forked-mainnet USDC session
  restored with a bogus RPC URL, new real `transfer()` succeeded with zero network).
- Bugs found and fixed along the way are listed in CLAUDE.md "Known gotchas".

## 4. The MVP (this repo) — what exists and is verified
Built and verified in headless Chromium (production build **and** `npm run dev`), `npm run e2e` prints the JSON below
and PASS:
- boot + deploy PEPE + Frogpond + opening liquidity (10 ETH + 8 M PEPE → 1 PEPE = 1,250 gwei) + 50 M PEPE to every
  account: **780 ms**
- connect via the dapp's EIP-6963 picker → add 2 ETH (PEPE leg auto-filled 1.6 M) → approve → add → position 16.67 %
- swap 1 ETH → price 1,250 → **1,467 gwei/PEPE**, chart gains a point, feed row "You swapped 1 ETH for 736.42K PEPE"
- swap 200 K PEPE back → 1,403; remove 50 % → 9.09 %
- reload: same price, same block #18, all 5 history rows back in **300 ms** (localStorage)
- "Pond life" on: a bot frog trades within seconds without human action (event-reactive actors work in-browser)
- screenshot: docs/frogpond-screenshot.png

Design: light glass-and-moss palette (#F2F6F3 / #14231B / #1F6F5C / #E8C547 / #CFE7E0), Bricolage Grotesque,
the chart is the hero, one control panel (Swap / Add liquidity / Remove), the dark bottom bar is the "glass".

## 5. Next steps as of the MVP (superseded — see §7–§9 for what was actually done next)
1. Run `npm install && npm run e2e:install && npm run e2e` on the Mac; open `npm run dev`. Confirm Google Fonts load
   (sandbox had no font access; system fallback was used in the screenshot).
2. Extract `sim/terrarium.js` into a publishable package (`packages/terrarium`): TypeScript types, the RPC parity list
   in design §6, `eth_subscribe` push over `message` events, IndexedDB persister, `forkOverrides`, differential
   tests against Anvil (same txs → same receipts/logs/gas).
3. Vite plugin: Foundry `out/` → typed artifacts module + `defineTerrarium()` config (chain, accounts, fork, mocks,
   deploy plan / broadcast replay, actors) — the generalized version of `scripts/build-contracts.mjs` +
   `src/terrarium-boot.ts`.
4. Frogpond polish: historical `eth_call` at old blocks (per-block state), fixture export/import buttons in the dev
   bar, scripted wallet rejections (4001) and RPC latency for resilience testing, SharedWorker for multi-tab
   multi-user.
5. File the two ethereumjs issues (RPCStateManager.commit, originalStorageCache in runCall).
6. Later: swap the interpreter for a WASM EVM (Guillotine) behind the same interface.

## 6. Suggested first prompt for Claude Code
> Read CLAUDE.md and HANDOFF.md. Run `npm install`, `npm run e2e:install` and `npm run e2e`; fix anything that fails on
> this machine. Then start `npm run dev` so I can click through Frogpond. After that, begin HANDOFF.md step 2 by
> proposing the package layout for `packages/terrarium` before changing files.

## 7. Second pass (2 Sep 2026, evening) — what changed and why
A review found the engine sound but the packaging around it self-defeating: a bespoke pool instead of a real
protocol, a wallet that could never fail, a boundary that leaked, no fork demo, fragile persistence, nothing
deterministic, and no positioning. All eight points were addressed:
1. **Real Uniswap V2.** `Frogpond.sol` is gone. The scenario installs the mainnet runtime bytecode of Router02,
   Factory and WETH9 at their mainnet addresses (`terrarium/fixtures/`, fetched with `cast code`); the dapp uses the
   Router02/Pair ABIs. PEPE stays as "your contract".
2. **Inverted integration.** `src/` has zero knowledge of the simulator. The Terrarium is injected by a Vite plugin
   (dev) or Playwright `addInitScript` (e2e, against the `VITE_TERRARIUM=off` build). The dev bar is a plain-DOM
   overlay driven by `provider.request()`.
3. **Wallet realism.** `terrarium_setWallet({ rejectNext, latencyMs, receiptLagMs })`, and `sim.node` (read-only
   node provider). The e2e exercises rejection (4001) and a slow wallet.
4. **State management.** Snapshot revert rolls back blocks, receipts, journal, filter cursors, the dump, and the UI
   history; persistence moved to IndexedDB, tx bodies pruned and log duplication removed; addresses are derived
   (deterministic deploy) instead of a side key; dropped txs get failed receipts.
5. **Test mode.** `clock`, `seed` (mulberry32, actors use `sim.random()`), `gasEstimation: 'fast'`.
6. **Fork demo + parity.** `test/fork-record.mjs` records a mainnet fork (real USDC proxy via `deal`, real USDC/WETH
   pair, real router) to `test/fixtures/`; `test/fork-offline.mjs` replays with `fetch` disabled (0 network calls).
   `test/uniswap-v2.mjs` gained an RPC parity table vs Anvil (block shape incl. Cancun fields, receipts, logs, filters,
   fee history, revert payloads).
7. **Worker.** The chain runs off the main thread; page ↔ worker via postMessage with error codes/data preserved.
8. **Positioning.** README rewritten around hosted previews/CI and live demo mode; honest limits listed.

Found along the way by running the real router: gas estimated against `latest` instead of the pending block makes
Uniswap swaps run out of gas (price accumulators). Fixed in `pendingBlock()`; caught by both the e2e and the offline
fork replay. Verified: `npm run e2e`, `npm run test:uniswap`, `npm run test:fork` all PASS.

## 8. Third pass (2 Sep 2026, night) — package split + scenario API
- `packages/terrarium` (npm workspace, imported as `terrarium`, `terrarium/scenario`, `terrarium/worker`,
  `terrarium/inject`, `terrarium/vite`, `terrarium/fixtures/*`): engine + injected layer + Vite plugin + CLI.
- `defineScenario({ chainId, seed, persist, setup(ctx), actors, actorsLabel, status, methods })` replaces the
  hand-written worker scenario; `runScenario` (Worker) provides `ctx` (viem clients, install, chain-clock deadline,
  seeded random, fresh flag, state bag) and the generic `terrarium_actors/status/reset` RPCs.
- Vite plugin takes `{ scenario }` and generates `.terrarium/{inject,worker}.ts`; CLI `terrarium build` produces the
  injectable bundle from any scenario, `terrarium fetch-code` makes bytecode fixtures without Foundry (`--block`, `--chain`),
  `terrarium record` forks a chain at a block, runs a warm-up script and dumps a self-verified offline fixture.
- HTTP routes (`http.ts`, `defineScenario({ http })`): the page's `fetch` is patched in `inject.ts`; matching requests go
  to the Worker (`terrarium_http`) where handlers / GraphQL resolvers answer from the chain. Frogpond answers the Uniswap
  V2 subgraph URL from its own Swap logs, with down / behind controls; the dapp consumes it with plain fetch
  (`src/lib/useIndexer.ts`). Docs: `docs/http-and-subgraphs.md`, `docs/cookbook.md`, `docs/README.md` (index).
- `terrarium-react` (`packages/terrarium-react`): `<Terrarium worker>`, `useTerrarium`, `<DevBar>` for React apps off Vite;
  `inject.ts` gained `{ devBar }` and `stopTerrarium()`. Docs: `docs/integrations.md`.
- Docs: `docs/tutorial-new-protocol.md` (4 steps), `docs/api.md` (everything). Verified: typecheck, plain/injected/CLI
  builds, e2e, test:uniswap, test:fork all PASS.
- Next (from the second analysis, as written then): HTTP mocking + in-Worker indexer (subgraph), mock contracts that can
  emit/write, fork warm-up + offline miss report + oracle override, Aave example, tracing in the dev bar, fixture CLI.
  Status (3 Sep 2026): all shipped except tracing and the in-Worker indexer; JS mocks were dropped on purpose. What is
  open lives in `docs/roadmap.md` from now on.

## 9. Fourth pass (2 Sep 2026, night) — verifiable blocks + WebAssembly engine
- **Verifiable headers.** `MerkleStateManager` by default (real `stateRoot`), real transactions trie, receipts trie
  and bloom in every header, impersonated txs with Anvil-style fake signatures; `test/uniswap-v2.mjs` recomputes hash and
  all roots from RPC output for every block on Terrarium and Anvil (16/16 each).
- **revm in WebAssembly.** `packages/terrarium-evm` (Rust, revm 43, no C deps, wasm-bindgen `--target web`, 1.5 MB)
  executes one tx per call against a JS `Host` (account/storage/blockHash) and returns result + state diff + SLOAD
  trace. `engine.js` gained a checkpoint-aware sync state mirror and a miss-and-retry loop; both engines share one
  result shape and pass the differential test byte for byte. Scenario default is `engine: 'revm'`.
- **The real bottleneck was never the EVM.** Profiling showed 83 % idle: viem wrapped our revert errors as "unknown" and
  retried 3× (1 s per reverted estimate). Engine and bridge errors now extend viem's BaseError. 14-tx scenario:
  js 2.5 s → 382 ms, revm 115 ms (28 ms inside wasm), Anvil 59 ms.
- Still JS-only at the time: `mockContract` (removed in 0.3, mock with bytecode instead). The rest of that list shipped;
  see `docs/roadmap.md` for what is open.
- Found by simply running the frontend after an idle hour: the dapp derived deadlines from `latest` and the real router
  said `EXPIRED`. `eth_getBlockByNumber('pending')` now returns the real next block (like geth/Anvil) and the dapp
  derives deadlines from it. Rule recorded in CLAUDE.md and the tutorial.
- Where things stand: all suites green (typecheck, e2e on the wasm bundle, test:uniswap on both engines incl. verifiable
  blocks + RPC parity, test:fork offline on both engines). Repo: github.com/damarnez/terrarium, branch main.

## 10. Fifth pass (2 Sep 2026, evening) — integration improvements + Aave and Euler examples
- Integration: `fork.offline` (misses throw `OfflineStateError`, listed in `sim.offlineMisses`, shown in the dev bar),
  `restore` as a baseline under `persist`, scenario `fork`/`restore`/`clock`/`controls`/`firstBoot`, dev-bar buttons from
  the scenario, `build-contracts.mjs [dir] [out]`, npm workspaces for `examples/*`.
- `examples/aave`: real Aave V3 Pool/aTokens/oracle from a recorded mainnet fork; health factor UI-vs-Pool check; ETH price
  control via `FixedPriceFeed` installed at the Chainlink source. `examples/euler`: EVK vaults + EVC; deposit, enable
  collateral/controller, borrow; risk-adjusted liquidity. Both: `record.mjs` (fork → snapshot → exercise → revert → dump),
  offline `test.mjs` on both engines. All PASS.
- Engine fixes found by the examples: snapshots restore the chain clock (revert had leaked an hour of `evm_increaseTime`
  into a fixture); known-absent accounts answer code/storage locally (ethereumjs asks for code where revm asks for the
  account, so a fixture recorded with one now serves the other).
- Learned: forked oracles rot. Euler's Chainlink adapters revert `PriceOracle_TooStale` an hour past the recorded round;
  `clock: 'recording'` keeps fixtures usable, and "+1 hour" in the dev bar shows the real failure mode.
- Follow-up commit: the dev bar says how many local blocks a reload restored; the example tests assert the fixture starts
  clean and that borrowing without collateral reverts.

## 11. Sixth pass (3 Sep 2026) — one engine, a unit suite, the docs
- **`@ethereumjs/vm` removed (0.3).** revm/wasm is the only execution engine; `engine: 'js'` throws. Gone with it:
  `createVM`, `runTx`, the JS `mockContract` (mock with bytecode instead), and the `@ethereumjs/vm` / `@ethereumjs/evm`
  dependencies. The bloom and the EIP-2718 receipt encoding are now the engine's own (from the spec); `test/uniswap-v2.mjs`
  verifies them against Anvil with a second, independent implementation. `sim.vm` became `sim.stateManager`. The other
  `@ethereumjs/*` packages stay for the trie, RLP, transactions and headers.
- **Unit suite.** `test/unit/*.test.mjs` on Node's test runner, sixty tests, no network / Foundry / browser: chain and
  clock, transactions and gas, cheatcodes and snapshots, `deal` / `setState` / `slotFromLayout`, logs, filters and
  actors, the wallet knobs and the node provider, persistence and journal replay, fork mode (the committed fixture
  offline, and an online fork against a local fake JSON-RPC node), the wasm engine's contract, the scenario runtime with
  shimmed Worker globals, the postMessage bridge with both ends in one process, the Vite plugin, and the CLI including a
  standalone build. `npm test` runs it with the fork and example replays.
- **Bugs the tests found:** `evm_setAutomine(true)` after interval mining left the interval timer running (the dev bar's
  toggle); an actor that threw synchronously escaped as an uncaught exception; `terrarium build --out <absolute>` broke;
  every `eth_call` on an online fork re-fetched the called contract's proof (the checkpoint dropped the cache). Also: the
  e2e now opens `localhost`, since Vite's preview server may bind IPv6 only (Node 25 on macOS did).
- **Docs.** Tutorial rewritten (two tracks, what `ctx` gives you, the dev bar, Node tests, use cases, troubleshooting);
  api.md corrected (`terrarium_status` shape, `fresh` vs `firstBoot`, `terrarium_reset`, Vite `define`, test ids, bridge);
  README gained the use-case table; design doc says what runs today.
