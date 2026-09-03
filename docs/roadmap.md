# Roadmap: what is not built yet

← [Docs index](README.md) · [README](../README.md) · [HANDOFF](../HANDOFF.md)

Everything in the other docs exists and is tested. This page is the opposite: the gaps we know about and the features
that would close them, in the order we would build them. Sizes are rough (S: a day, M: a few days, L: a week or more).
If you pick one up, open with a note in HANDOFF.md so the next person knows.

| # | what | the gap it closes | size |
|---|---|---|---|
| 1 | [Live forking that feels finished](#1-live-forking-that-feels-finished) | forking a real chain through an RPC works but needs a block number, refetches on every reload and is recorded from Node only | M |
| 2 | [`npx terrarium serve`](#2-npx-terrarium-serve) | real wallets (MetaMask, Rabby) and CLI tools cannot connect to the chain | M |
| 3 | [Tracing in the dev bar](#3-tracing-in-the-dev-bar) | "my transaction reverted" has no call tree, no frame, no gas per call | L |
| 4 | [Prague hardfork and the modern wallet surface](#4-prague-hardfork-and-the-modern-wallet-surface) | Cancun rules while mainnet is on Prague; no EIP-7702, no EIP-5792 batched calls; constant base fee | M |
| 5 | [Boot and estimation speed](#5-boot-and-estimation-speed) | page load is dominated by wasm instantiation, restore and setup; estimation runs the tx many times | M |
| 6 | [`npx terrarium init` and an npm release](#6-npx-terrarium-init-and-an-npm-release) | starting a new project is a manual copy from this repo; the package is workspace-only | S |
| 7 | [A typed `sim`](#7-a-typed-sim) | `ctx.sim` is `any`; no autocompletion where users spend their time | S |
| 8 | [HTTP layer, one step further](#8-http-layer-one-step-further) | no latency / failure knobs for routes, no request log, every subgraph field is hand-written | M |
| 9 | [Fidelity beyond Uniswap](#9-fidelity-beyond-uniswap) | the differential test covers one DEX scenario | M |
| 10 | [Two chains in one page](#10-two-chains-in-one-page) | bridging and cross-chain dapps cannot be tested | L |

## 1. Live forking that feels finished

Today: `fork: { url, blockNumber }` reads state lazily from any node and records every read; the Aave and Euler
scenarios switch to it when `VITE_FORK_RPC` is set ([tutorial](tutorial-new-protocol.md#1-get-the-protocol-in),
[cookbook §14](cookbook.md#14-forks-online-offline-recorded)). Missing:

- `blockNumber: 'latest'`, resolved at boot a few blocks back so a scenario can say "fork mainnet now".
- The remote-read cache persisted in IndexedDB, so a reload does not refetch and public RPC rate limits stop mattering;
  batched JSON-RPC for the state manager's `eth_getProof` / `eth_getStorageAt` calls.
- A **Download fixture** button in the dev bar: click through the dapp online, press it, get the offline fixture that
  replays the same session in CI. Most people would never write a recorder script again.
- Browser realities: a CORS note per known public RPC, and a clear dev-bar message when the node refuses browser origins.

## 2. `npx terrarium serve`

The engine already runs in Node. Put it behind a JSON-RPC HTTP (and WebSocket) server on a port and it is an Anvil with
scenario superpowers: MetaMask, Rabby, `cast`, wagmi with an `http` transport connect unchanged, the scenario's actors and
controls keep working, and several browsers can share one chain for a demo. Reuse the scenario file (`runScenario`
without a page), expose `terrarium_*` over HTTP, mirror the dev bar as a tiny local web page. This is the most direct
answer to "closer to the real thing": the real wallet is in the loop.

## 3. Tracing in the dev bar

revm has inspectors. Implement `debug_traceTransaction` and `debug_traceCall` (call tracer shape, as geth), then a
per-transaction panel in the dev bar: the call tree, the frame that reverted with its decoded reason, events and gas per
call, storage writes. The engine's `stats` already counts runs and rounds; this is the same data one level deeper. It is
where frontend developers lose the most time today.

## 4. Prague hardfork and the modern wallet surface

- Check that `hardfork: 'prague'` reaches revm (the engine passes the hardfork name as revm's spec string, so it may
  already work), cover the BLS precompiles and EIP-7702 set-code transactions in the differential test, make it the default.
- `wallet_sendCalls` / `wallet_getCallsStatus` / `wallet_getCapabilities` (EIP-5792) so dapps built for batched calls and
  smart accounts can be tested, with a paymaster stub.
- The real EIP-1559 base-fee formula per block from the previous block's gas used, instead of a constant until set.
- Blob transactions (type 3) if a target dapp needs them; today they are not accepted.
- Log subscriptions on `eth_subscribe` (only new heads are pushed now).

## 5. Boot and estimation speed

Measure first: add `timings` to `terrarium_status` (wasm instantiate, restore, `setup`, first block) and show them in the
dev bar. Then, in likely order of payoff: cache the compiled wasm module (Cache API) so a reload skips compilation;
replace the binary search in gas estimation with the execution's own gas use plus one confirming run, as newer geth does
(far fewer simulated runs per transaction); make the Merkle state root lazy or optional per block for scenarios that do
not verify headers; batch persistence writes during `setup`. Execution itself is not the bottleneck: the wasm is within
2× of native Anvil on the reference scenario.

## 6. `npx terrarium init` and an npm release

Scaffold a project: `terrarium.scenario.ts` with the Uniswap fixture, a `vite.config.ts` with the plugin and the
`define` block, `.env`, `.gitignore` entries, and an `npm run e2e` skeleton. Publish `terrarium` and `terrarium-evm` to npm
with the wasm inside; today the package works only as a workspace. Both are small and remove the first hour of friction
the tutorial currently has to explain.

## 7. A typed `sim`

`ScenarioContext.sim` is `any` because `engine.js` is plain JavaScript. Write a declaration file for the engine (or move
the public surface into a `.ts` facade) so `ctx.sim.deal(...)`, `setState`, `sendAs`, `snapshot` autocomplete and
type-check in scenarios and recorders. The API reference already lists every member; the `.d.ts` is that table as code.

## 8. HTTP layer, one step further

- Route knobs like the wallet's: `terrarium_setHttp({ latencyMs, failNext, status })`, with dev-bar buttons, so "the
  API is slow" is one click for every scenario rather than code in each handler.
- A request log in the dev bar: URL, matched route, status, time.
- A small in-Worker indexer: given a subgraph schema and an event-to-entity mapping, keep entities in memory from the
  logs and answer common list queries (`first`, `skip`, `orderBy`, `where` equality) without hand-written resolvers.
- XHR interception for axios-by-default dapps.

## 9. Fidelity beyond Uniswap

The differential test proves byte-identical receipts, logs and blocks against Anvil for one Uniswap V2 scenario. Extend it
to a fork: run the Aave fixture's supply / borrow / repay on Anvil forked at the same block and compare receipts and
storage writes. Add a fuzzing run that sends random valid and invalid transactions to both and compares receipts and
state roots. Then the "byte-identical" claim covers lending, proxies and oracles, not just a DEX.

## 10. Two chains in one page

Bridging and cross-chain dapps need two chains, two wallets with different chain ids, and `wallet_switchEthereumChain`
moving the same wallet between them. The architecture allows it (one Worker per chain, one EIP-6963 announcement each, or
one wallet that switches); nothing implements it. Scenario shape to design: `chains: [{ chainId, ... }, { ... }]` with
actors that relay messages between them.

## Not planned

- **JavaScript-mocked contracts.** Every call runs bytecode; fake a contract with a Solidity stand-in at the real address
  (README, "Honest limits").
- **A local state trie in fork mode.** Remote state is unknown, so forked chains report a placeholder `stateRoot`.
- **Rewriting RPC responses.** Off-chain endpoints are answered from the chain; the chain itself is never faked.
