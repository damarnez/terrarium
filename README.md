# Terrarium

A complete EVM chain that lives inside the page, presented to your dapp as a wallet. Real bytecode execution
(`@ethereumjs/vm`), real receipts, logs and reverts, byte-identical to Anvil. No node process, no browser extension,
no faucet. Your dapp does not know it is there.

Two things it is for that a local node cannot do:

1. **Hosted previews and CI with zero infrastructure.** A Vercel preview URL, a Storybook, a Playwright run: the chain
   is injected into the page like a wallet extension would be. Deterministic, offline, no RPC quota.
2. **A live demo mode of your real dapp.** Visitors click through the production UI against real protocol contracts
   with fake money, with other actors trading around them, without installing anything.

Inside this repo: **Frogpond**, an ordinary ETH/PEPE dapp on the **real Uniswap V2** (mainnet bytecode of the
Router02, Factory and WETH9), used as the working example.

## Quickstart
```bash
npm install
npm run dev            # http://localhost:5173 → "Connect wallet" → "Terrarium Wallet"
```
Add liquidity, swap, remove liquidity through the real router. In the dark bar at the bottom: mine blocks, shift
time, switch to 3 s blocks, snapshot and revert (chain **and** UI history come back), turn on **Pond life** (bot
frogs trade against you, one fades your swaps), make the wallet **reject** the next signature, answer **slowly**, or
deliver receipts **late**. Reload the page: the chain is still there (IndexedDB, inside a Worker). **Reset pond**
wipes it and redeploys.

## Your own protocol in four steps
See [docs/tutorial-new-protocol.md](docs/tutorial-new-protocol.md): fetch the bytecode (or fork), write
`terrarium.scenario.ts`, add the Vite plugin, run it headless. Every option and RPC method: [docs/api.md](docs/api.md).

## How it fits together
```
                 ┌──────────────────────── the page ─────────────────────────┐
                 │  src/                 the dapp: viem + EIP-6963 only        │
                 │                       config = chain id + 2 addresses      │
   injected  ──► │  terrarium/inject     EIP-6963 "Terrarium Wallet" + dev bar│
   (vite plugin  │        │ postMessage                                        │
   or            │  terrarium/worker  ◄─ runScenario(terrarium.scenario.ts)   │
   addInitScript)│                       on the engine (EVM, blocks, receipts,│
                 │                       logs, cheatcodes, IndexedDB)         │
                 └───────────────────────────────────────────────────────────┘
packages/terrarium/     the library: engine.js, scenario.ts, worker-runtime.ts, inject.ts, devbar.ts, vite-plugin.ts, bin/
terrarium.scenario.ts   the example scenario: real Uniswap V2 + PEPE + bot frogs     contracts/PEPE.sol ──solc──► src/generated/
```
- **The dapp never imports the simulator.** `src/` is configured by `.env` (`VITE_CHAIN_ID`, `VITE_ROUTER_ADDRESS`,
  `VITE_TOKEN_ADDRESS`, optional `VITE_RPC_URL`) and talks to whatever wallet announces itself. Build with
  `VITE_TERRARIUM=off` and not one byte of the simulator is in the bundle (the e2e asserts this).
- **The Terrarium is injected from outside.** In dev, the Vite plugin (`terrarium/vite`) adds one `<script>` to
  `index.html`. In tests, Playwright injects `dist-terrarium/terrarium.js` (`npx terrarium build`) with
  `addInitScript`, like a wallet extension. The dev bar is a plain-DOM overlay driven through `provider.request()`.
- **The chain runs in a Worker**, so a 3M-gas transaction never freezes the UI. Persistence is IndexedDB.
- **The pool is the real Uniswap V2.** `terrarium.scenario.ts` (`defineScenario`) installs the mainnet runtime
  bytecode at the mainnet addresses, deploys PEPE (your contract), seeds the pair through the router and declares the
  actors. The dapp uses the Router02 / Pair ABIs it would use on mainnet.

## Tests
```bash
npm run e2e:install    # once: Chromium for Playwright
npm run e2e            # plain dapp build (VITE_TERRARIUM=off) + injected Terrarium, the whole flow in headless Chromium
npm run test:uniswap   # real Uniswap V2 in the Terrarium vs Anvil: every tx hash, receipt, log, eth_call and revert byte-identical, + RPC parity table
npm run test:fork      # offline replay of a recorded mainnet fork (real USDC proxy, real USDC/WETH pair): new swaps, zero network
npm run test:fork:record   # re-record that fixture against mainnet (needs network)
```
The e2e covers: connect via the picker, approve + add liquidity, a deposit with no funds (the real router's
`TransferHelper: TRANSFER_FROM_FAILED`, decoded), the wallet rejecting a signature (4001), a 2 s wallet delay with a
visible pending state, swaps both ways, snapshot → swap → revert, LP approval + remove, reload, and Pond life.
`test:uniswap` needs Foundry (Anvil) on the PATH.

## The engine directly (Node, Vitest, your own harness)
```ts
import { createTerrarium, indexedDBStorage } from 'terrarium';
const sim = await createTerrarium({
  chainId: 8453,
  persist: { storage: indexedDBStorage('my-dapp'), key: 'scenario' },
  seed: 42,                          // deterministic actors
  clock: () => fixedSeconds,         // deterministic block timestamps (tests)
  gasEstimation: 'fast',             // skip geth-style estimation in CI
  wallet: { latencyMs: 800 },        // a wallet that behaves like a wallet
});
await sim.deal(USDC, user, 5_000n * 10n ** 6n);          // fake balance on any ERC20, proxies included
sim.onLog({ address: vault, topics: [DepositTopic] }, (log) => sim.sendAs(keeper, {...}));  // other parties react
sim.provider                                             // the wallet (EIP-1193)
sim.node                                                 // the same chain as a node RPC: no accounts, no signing
await sim.provider.request({ method: 'terrarium_setWallet', params: [{ rejectNext: 1 }] });
```
Fork a live chain instead of starting empty: `createTerrarium({ chainId: 1, fork: { url, blockNumber } })`; every
remote read is recorded, so `sim.dumpState()` is an offline fixture (`test/fork-record.mjs` / `test/fork-offline.mjs`).

## Honest limits
- The engine is a JavaScript EVM interpreter, ~40× slower than Anvil (2.3 s vs 70 ms for the 14-tx differential
  run, most of it gas estimation). Use `gasEstimation: 'fast'` in CI; a WASM EVM behind the same interface is the
  planned fix.
- Block headers carry zero state/transactions/receipts roots and an empty bloom. Hashes are well-formed, not
  verifiable.
- No `eth_subscribe` push yet (viem polls, which works).

## Docs
- `CLAUDE.md`: operating manual and hard rules (also read by Claude Code).
- `HANDOFF.md`: the story: idea, investigation, decisions, verified numbers, next steps.
- `docs/design-investigation.md`: the full investigation and design document.
