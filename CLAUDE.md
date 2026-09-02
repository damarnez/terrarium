# Terrarium — project context for Claude Code

Read HANDOFF.md first for the full story. This file is the short operating manual.

## What this is
- **Terrarium** (`packages/terrarium/src/engine.js`): a self-contained EVM chain exposed as an EIP-1193 provider. Two
  execution engines behind one result shape: `engine: 'revm'` (revm 43 compiled to WebAssembly, `packages/terrarium-evm`,
  Rust + wasm-bindgen; the scenario default) and `engine: 'js'` (`@ethereumjs/vm`, the reference). State, checkpoints,
  persistence and fork recording are JavaScript in both; revm reads through a sync, checkpoint-aware state mirror
  (miss => zero/non-existent locally, fetch + re-run in fork mode). Blocks are sealed with real tx/receipt tries,
  bloom and (merkle mode) stateRoot. Blocks, receipts, logs, filters, Anvil/Hardhat cheatcodes, JS-mocked
  contracts, event-reactive actors, wallet-realism knobs (rejection / latency / receipt lag), a read-only `node`
  provider, injectable clock + seeded PRNG, persistence (IndexedDB / any getItem-setItem store), journal replay,
  snapshots that roll back everything, fork mode with offline fixtures, live block following.
- **The library** (`packages/terrarium`, npm workspace, imported as `terrarium/*`): `scenario.ts` (`defineScenario`
  + types), `worker-runtime.ts` (`runScenario`: boots the engine in a **Worker**, runs setup, wires actors, exposes
  `terrarium_actors/status/reset`), `bridge.ts` + `inject.ts` (postMessage bridge, EIP-6963 "Terrarium Wallet",
  `window.terrarium`), `devbar.ts` (plain-DOM overlay), `vite-plugin.ts` (generates `.terrarium/{inject,worker}.ts`
  and injects one script), `bin/terrarium.mjs` (CLI: `build` standalone bundle, `fetch-code` fixtures),
  `fixtures/uniswap-v2-mainnet.json`.
- **The example scenario** (`terrarium.scenario.ts` at the root): installs the REAL Uniswap V2 at the mainnet
  addresses, deploys PEPE, seeds the pair, declares the bot-frog actors.
- **Frogpond** (`src/`): an ordinary dapp on Uniswap V2 (Router02 / Pair ABIs in `src/lib/uniswap.ts`). Configured by
  `.env`: chain id, router address, token address, optional read RPC. Vite + React 19 + TypeScript + viem 2.
- **Contracts** (`contracts/PEPE.sol`), compiled by `scripts/build-contracts.mjs` into `src/generated/contracts.ts`.

## Commands
```
npm install
npm run build:contracts      # Solidity -> src/generated/contracts.ts (+ contracts/out/*.json)
npm run dev                  # http://localhost:5173  -> Connect wallet -> Terrarium Wallet
npm run typecheck
npm run build                # dapp WITH the terrarium injected (demo mode); VITE_TERRARIUM=off npm run build = plain dapp
npm run build:terrarium      # = npx terrarium build: standalone injectable dist-terrarium/terrarium.js
npm run e2e:install          # once: Chromium for Playwright
npm run e2e                  # plain build + injected terrarium, whole flow in headless Chromium (JSON + PASS/FAIL)
npm run test:uniswap         # real Uniswap V2 in the Terrarium vs Anvil: byte-identical receipts + RPC parity (needs Foundry)
npm run test:fork            # offline replay of the recorded mainnet fork fixture (test/fixtures/); test:fork:record re-records
```

## Hard rules (keep these)
1. **The dapp never imports or references the simulator.** `src/**` uses viem + EIP-6963 discovery + `.env` only.
   No `window.terrarium`, no rdns special-casing, no dev bar component. Scenario code lives in `terrarium.scenario.ts`. The e2e runs the `VITE_TERRARIUM=off` build
   and asserts no simulator chunk exists; keep it that way.
2. **Change EVM state, never RPC responses.** Fake balances go in via `sim.deal`, `sim.setState`, cheatcodes or real
   impersonated transactions, never by rewriting `eth_call` results.
3. **Every state mutation goes through the RPC layer** (`handle()` in `packages/terrarium/src/engine.js`) so it lands in the journal
   and persistence. Scenario controls are `terrarium_*` RPC methods (`sim.addMethod`), not side channels.
4. **All state-touching work is serialized** through the single `exclusive()` queue. Never call `mine()`, `runTx`,
   `checkpoint/revert` from outside it. Wallet latency/rejection run in the gate *before* the lock on purpose.
5. Contract changes: edit `contracts/*.sol`, run `npm run build:contracts`, never hand-edit `src/generated/`.
6. Fidelity claims must be backed by `npm run test:uniswap` (differential vs Anvil, BOTH engines, verifiable blocks, RPC
   parity). If you touch tx execution, gas, blocks, receipts, logs, revert data or the state mirror, run it.
7. RPC errors thrown to viem must extend viem's `BaseError` (`RpcError` in the engine, `ProviderRpcError` in the bridge):
   a foreign error with an unknown code is wrapped as "unknown" and retried 3× with backoff (1 s per reverted estimate).
8. Rust changes: `npm run build:wasm` regenerates `packages/terrarium-evm/pkg` (committed, so JS-only users need no Rust).

## Known gotchas (already handled in packages/terrarium/src/engine.js — do not "clean up" these)
- `@ethereumjs/statemanager` 10.1.3 `RPCStateManager.commit()` only commits the *account* cache → subclass commits all.
- Bare `runCall` does not clear `originalStorageCache` → `withRollback()` clears it first.
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

## Where things are
- Tutorial: `docs/tutorial-new-protocol.md`. API reference (all options, sim members, RPC methods, scenario config,
  plugin, CLI): `docs/api.md`. Keep both in sync with `packages/terrarium/src`.
- Engine API reference: `docs/design-investigation.md` Appendix A; state/persistence chapter §4b.
- E2E expectations and numbers: `e2e/frogpond.e2e.mjs`.
- Fidelity proof: `test/uniswap-v2.mjs`; fork demo: `test/fork-record.mjs`, `test/fork-offline.mjs`.
- Test accounts: the 10 Anvil keys (`TEST_KEYS`); account 0 is "you", account 9 the treasury that deploys PEPE and
  seeds the pool, accounts 6–8 the "Pond life" bot frogs. PEPE's address is deterministic (treasury nonce 0).
