# Roadmap: what is not built yet

← [Docs index](README.md) · [README](../README.md) · [HANDOFF](../HANDOFF.md)

Everything in the other docs exists and is tested. This page is the opposite: the gaps we know about and the features
that would close them, in the order we would build them. Sizes are rough (S: a day, M: a few days, L: a week or more).
If you pick one up, open with a note in HANDOFF.md so the next person knows.

| # | what | the gap it closes | size |
|---|---|---|---|
| 1 | [Live forking that feels finished](#1-live-forking-that-feels-finished) | forking a real chain through an RPC works but needs a block number, refetches on every reload and is recorded from Node only | M |
| 2 | [`npx terrarium serve`](#2-npx-terrarium-serve) | real wallets (MetaMask, Rabby) and CLI tools cannot connect to the chain | M |
| 3 | [Tracing in the dev bar](#3-tracing-in-the-dev-bar) | the explorer shows receipt, decoded call, events and revert reason; "my transaction reverted" still has no call tree, no frame, no gas per call | L |
| 4 | [Prague hardfork and the modern wallet surface](#4-prague-hardfork-and-the-modern-wallet-surface) | Cancun rules while mainnet is on Prague; no EIP-7702, no EIP-5792 batched calls; constant base fee | M |
| 5 | [Boot and estimation speed](#5-boot-and-estimation-speed) | estimation is solved (reth's search inside the wasm) and the wasm compiles in milliseconds; what remains is timings in the status, a lazy state root and batched setup writes | M |
| 6 | [`npx terrarium init`](#6-npx-terrarium-init-and-an-npm-release) | starting a new project is a manual copy from this repo (the npm release itself is done: `@terrariumlabs/core`, `@terrariumlabs/evm`, `@terrariumlabs/react`) | S |
| 7 | [A typed `sim`](#7-a-typed-sim) | `ctx.sim` is `any`; no autocompletion where users spend their time | S |
| 8 | [HTTP layer, one step further](#8-http-layer-one-step-further) | no latency / failure knobs for routes, no request log, every subgraph field is hand-written | M |
| 9 | [Fidelity beyond Uniswap](#9-fidelity-beyond-uniswap) | the differential test covers one DEX scenario | M |
| 10 | [Two chains in one page](#10-two-chains-in-one-page) | bridging and cross-chain dapps cannot be tested | L |

## 1. Live forking that feels finished

Today: `fork: { url, blockNumber }` reads state lazily from any node and records every read; the Aave and Euler
scenarios switch to it when `VITE_FORK_RPC` is set ([tutorial](tutorial-new-protocol.md#1-get-the-protocol-in),
[cookbook §14](cookbook.md#14-forks-online-offline-recorded)). Four things are missing.

A scenario should be able to say "fork mainnet now": `blockNumber: 'latest'`, resolved at boot a few blocks back.

The remote-read cache should persist in IndexedDB, so a reload does not refetch and public RPC rate limits stop
mattering. Alongside it, the state manager's `eth_getProof` and `eth_getStorageAt` calls should go out as batched
JSON-RPC.

A **Download fixture** button belongs in the dev bar: you click through the dapp online, press it, and get the offline
fixture that replays the same session in CI. Most people would never write a recorder script again.

Browser realities need covering too: a CORS note per known public RPC, and a clear dev-bar message when the node
refuses browser origins.

## 2. `npx terrarium serve`

The engine already runs in Node. Put it behind a JSON-RPC HTTP (and WebSocket) server on a port and it is an Anvil with
scenario superpowers: MetaMask, Rabby, `cast`, wagmi with an `http` transport connect unchanged, the scenario's actors and
controls keep working, and several browsers can share one chain for a demo. Reuse the scenario file (`runScenario`
without a page), expose `terrarium_*` over HTTP, mirror the dev bar as a tiny local web page. This is the most direct
answer to "closer to the real thing": the real wallet is in the loop.

## 3. Tracing in the dev bar

The dev bar's transaction explorer (0.4) already lists every transaction with its receipt, the decoded call, the events and
the decoded revert reason (`terrarium_transactions`, decoded with the scenario's `abis`). What is missing is depth: revm has
inspectors. Implement `debug_traceTransaction` and `debug_traceCall` (call tracer shape, as geth), then extend the explorer's
row detail with the call tree, the frame that reverted, gas per call, storage writes. The engine's `stats` already counts runs and rounds; this is the same data one level deeper. It is
where frontend developers lose the most time today.

## 4. Prague hardfork and the modern wallet surface

First, check that `hardfork: 'prague'` reaches revm. The engine passes the hardfork name as revm's spec string, so it
may already work. Then cover the BLS precompiles and EIP-7702 set-code transactions in the differential test, and make
Prague the default.

Dapps built for batched calls and smart accounts need `wallet_sendCalls`, `wallet_getCallsStatus` and
`wallet_getCapabilities` (EIP-5792), with a paymaster stub so they can be tested.

The base fee should follow the real EIP-1559 formula per block, computed from the previous block's gas used, instead of
staying constant until someone sets it.

Blob transactions (type 3) are not accepted today; add them if a target dapp needs them.

`eth_subscribe` only pushes new heads now; log subscriptions would complete it.

## 5. Boot and estimation speed

Two of the three suspects are measured and closed. Gas estimation runs reth's search inside the wasm in a single call: 0.7 ms
for a Uniswap swap where the JavaScript search took 16.7 ms, and viem's `writeContract` end to end went from 18 ms to 6 ms.
The wasm module compiles in 1 to 3 ms in Chromium and a reload to a chain that answers takes about 190 ms, so a compiled-module
cache would save nothing and is not planned.

What remains: add `timings` to `terrarium_status` (wasm instantiate, restore, `setup`, first block) and show them in the dev bar,
so a slow first boot can be attributed; make the Merkle state root lazy or optional per block for scenarios that never verify
headers; batch persistence writes during `setup`. Execution itself is not the bottleneck: the reference scenario runs at about
110 ms against 75 to 100 ms on native Anvil.

## 6. `npx terrarium init` and an npm release

Scaffold a project: `terrarium.scenario.ts` with the Uniswap fixture, a `vite.config.ts` with the plugin and the
`define` block, `.env`, `.gitignore` entries, and an `npm run e2e` skeleton. The npm side is done: `@terrariumlabs/core`,
`@terrariumlabs/evm` (wasm inside) and `@terrariumlabs/react` publish from the workspaces (`npm publish -w @terrariumlabs/evm`, then `core`,
then `react`; `publishConfig.access` is public, inter-package ranges are pinned to the current version). The Vite plugin is plain JS
(`vite-plugin.js` + `.d.ts`) because Node will not type-strip a `.ts` file inside a consumer's `node_modules`; the other
`.ts` entries are browser code that a bundler transpiles. The scaffold is what remains.

## 7. A typed `sim`

`ScenarioContext.sim` is `any` because `engine.js` is plain JavaScript. Write a declaration file for the engine (or move
the public surface into a `.ts` facade) so `ctx.sim.deal(...)`, `setState`, `sendAs`, `snapshot` autocomplete and
type-check in scenarios and recorders. The API reference already lists every member; the `.d.ts` is that table as code.

## 8. HTTP layer, one step further

Routes deserve knobs like the wallet's: `terrarium_setHttp({ latencyMs, failNext, status })`, with dev-bar buttons, so
"the API is slow" becomes one click for every scenario rather than code in each handler.

The dev bar should show a request log with the URL, the matched route, the status and the time.

A small in-Worker indexer would remove most hand-written resolvers: given a subgraph schema and an event-to-entity
mapping, it would keep entities in memory from the logs and answer the common list queries (`first`, `skip`, `orderBy`,
`where` equality).

Dapps that use axios with its default adapter need XHR interception.

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

There will be no JavaScript-mocked contracts. Every call runs bytecode, so you fake a contract with a Solidity stand-in
at the real address (see "Honest limits" in the README).

There will be no local state trie in fork mode. Remote state is unknown, so forked chains report a placeholder
`stateRoot`.

RPC responses will never be rewritten. Off-chain endpoints are answered from the chain, and the chain itself is never
faked.
