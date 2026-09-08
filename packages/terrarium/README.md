# @terrariumlabs/core

```sh
npm install -D @terrariumlabs/core          # pulls @terrariumlabs/evm (the wasm engine); peer: viem 2, and vite for the plugin
```

A complete EVM chain inside the page, presented to your dapp as an EIP-6963 wallet. Real bytecode execution (revm
compiled to WebAssembly), real and verifiable blocks, receipts, logs and reverts, byte-identical to Anvil. Your dapp does
not know it is there.

## Entry points
| import | what |
|---|---|
| `@terrariumlabs/core` / `@terrariumlabs/core/engine` | `createTerrarium(options) → sim`, `indexedDBStorage()`, `TEST_KEYS` — the engine, usable in Node, Vitest, a Worker |
| `@terrariumlabs/core/scenario` | `defineScenario(config)`, `defineScenarios([...])` (a list: the dev bar gets a selector, each keeps its own chain), `reply()` + types — what runs in the Worker when the page loads, including `http` routes that answer the dapp's subgraph / API calls from the chain |
| `@terrariumlabs/core/http` | `parseGraphql`, `installHttpInterceptor`, `runRoute` — the HTTP interception layer, for custom hosts and tests |
| `@terrariumlabs/core/worker` | `runScenario(config)` — the Worker runtime (boot, setup, actors, `terrarium_*` RPCs, provider bridge) |
| `@terrariumlabs/core/inject` | `startTerrarium(worker, { devBar?: true \| 'hidden' \| false })` / `stopTerrarium()` — page side: EIP-6963 announcement, `window.terrarium`, dev bar, the `fetch` interceptor |
| `@terrariumlabs/core/devbar` | `mountDevBar(provider, { hidden? })` / `unmountDevBar()` — only the dev bar (controls, transaction explorer, scenario selector), over any provider answering the `terrarium_*` methods |
| `@terrariumlabs/core/bridge` | `serveProvider` / `createWorkerProvider` — the postMessage bridge, for custom hosts |
| `@terrariumlabs/core/vite` | `terrarium({ scenario?, devBar?, mount? })` — Vite plugin: injects the whole thing into `index.html` (or, with `mount: 'react'`, hands the app a React mount); off with `VITE_TERRARIUM=off` |
| `@terrariumlabs/core/transport` | `terrariumTransport()` — a viem transport that finds the Terrarium Wallet on the page, for wagmi's `transports` |
| `@terrariumlabs/core/fixtures/uniswap-v2-mainnet.json` | mainnet runtime bytecode of Uniswap V2 Router02, Factory, WETH9, for `ctx.install()` |
| `npx terrarium build` | one injectable script (chain + wallet + dev bar) for Playwright & co. |
| [`@terrariumlabs/react`](../terrarium-react/README.md) | `<Terrarium worker={…}>` for React apps that cannot use the Vite plugin (Next.js, Storybook); see [docs/integrations.md](../../docs/integrations.md) |
| `npx terrarium fetch-code` / `record` / `import-anvil` | fixtures from any node: the runtime bytecode of named contracts, the state of a chain at a block (`--chain`, `--block`, a warm-up `--script`) as an offline fork, or everything a running Anvil holds, with names and ABIs from a Foundry broadcast (`--broadcast`, `--artifacts`) |

## Minimal use
```ts
// terrarium.scenario.ts
import { defineScenario } from '@terrariumlabs/core/scenario';
import uniswap from '@terrariumlabs/core/fixtures/uniswap-v2-mainnet.json';
export default defineScenario({
  persist: 'my-dapp',
  async setup(ctx) { await ctx.install(uniswap); if (ctx.fresh) { /* deploy + seed with ctx.wallet(ctx.accounts[9]) */ } },
});
```
```ts
// vite.config.ts
import { terrarium } from '@terrariumlabs/core/vite';
export default defineConfig({
  plugins: [react(), terrarium()],
  define: { 'process.env.DEBUG': 'undefined', 'process.env.TERRARIUM_DEBUG': 'undefined' },   // ethereumjs → debug → process.env
  build: { target: 'es2022' }, worker: { format: 'es' },
});
```
```js
// Playwright, against the dapp built with VITE_TERRARIUM=off
await page.addInitScript({ path: 'dist-terrarium/terrarium.js' });   // npx terrarium build
```

The documentation starts at the [index](../../docs/README.md). From there, the [tutorial](../../docs/tutorial-new-protocol.md) walks you through a new project, the [off-chain data](../../docs/http-and-subgraphs.md) guide covers subgraphs and APIs, the [cookbook](../../docs/cookbook.md) has one example per feature, and the [API reference](../../docs/api.md) lists every option.

## Rules the engine keeps
Every state mutation goes through the RPC layer, where it is journaled and persisted, and all state work is serialized in one queue, so nothing ever runs against a half-updated chain.

Fake balances go in as EVM state, through `sim.deal`, `sim.setState`, the cheatcodes or impersonated transactions. The engine never rewrites a response to fake a balance, so what the dapp reads is always what the chain holds.

Errors thrown to the dapp extend viem's `BaseError`. viem therefore treats them like a real node's errors and does not retry a revert three times with backoff.

Fidelity is proven, not claimed. `npm run test:uniswap` in the repo root runs the same scenario here and on Anvil and compares the results byte for byte, and `npm test` covers the rest.
