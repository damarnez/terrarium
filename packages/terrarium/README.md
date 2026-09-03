# terrarium

A complete EVM chain inside the page, presented to your dapp as an EIP-6963 wallet. Real bytecode execution (revm
compiled to WebAssembly), real and verifiable blocks, receipts, logs and reverts, byte-identical to Anvil. Your dapp does
not know it is there.

## Entry points
| import | what |
|---|---|
| `terrarium` / `terrarium/engine` | `createTerrarium(options) → sim`, `indexedDBStorage()`, `TEST_KEYS` — the engine, usable in Node, Vitest, a Worker |
| `terrarium/scenario` | `defineScenario(config)`, `reply()` + types — what runs in the Worker when the page loads, including `http` routes that answer the dapp's subgraph / API calls from the chain |
| `terrarium/http` | `parseGraphql`, `installHttpInterceptor`, `runRoute` — the HTTP interception layer, for custom hosts and tests |
| `terrarium/worker` | `runScenario(config)` — the Worker runtime (boot, setup, actors, `terrarium_*` RPCs, provider bridge) |
| `terrarium/inject` | `startTerrarium(worker, { devBar? })` / `stopTerrarium()` — page side: EIP-6963 announcement, `window.terrarium`, dev bar, the `fetch` interceptor |
| `terrarium/devbar` | `mountDevBar(provider)` — only the dev bar, over any provider answering the `terrarium_*` methods |
| `terrarium/bridge` | `serveProvider` / `createWorkerProvider` — the postMessage bridge, for custom hosts |
| `terrarium/vite` | `terrarium({ scenario? })` — Vite plugin: injects the whole thing into `index.html`; off with `VITE_TERRARIUM=off` |
| `terrarium/fixtures/uniswap-v2-mainnet.json` | mainnet runtime bytecode of Uniswap V2 Router02, Factory, WETH9, for `ctx.install()` |
| `npx terrarium build` | one injectable script (chain + wallet + dev bar) for Playwright & co. |
| [`terrarium-react`](../terrarium-react/README.md) | `<Terrarium worker={…}>` for React apps that cannot use the Vite plugin (Next.js, Storybook); see [docs/integrations.md](../../docs/integrations.md) |
| `npx terrarium fetch-code` / `npx terrarium record` | fixtures from any node: the runtime bytecode of named contracts, or the state of a chain at a block (`--chain`, `--block`, a warm-up `--script`) as an offline fork |

## Minimal use
```ts
// terrarium.scenario.ts
import { defineScenario } from 'terrarium/scenario';
import uniswap from 'terrarium/fixtures/uniswap-v2-mainnet.json';
export default defineScenario({
  persist: 'my-dapp',
  async setup(ctx) { await ctx.install(uniswap); if (ctx.fresh) { /* deploy + seed with ctx.wallet(ctx.accounts[9]) */ } },
});
```
```ts
// vite.config.ts
import { terrarium } from 'terrarium/vite';
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

Docs: [index](../../docs/README.md) · [tutorial](../../docs/tutorial-new-protocol.md) · [off-chain data](../../docs/http-and-subgraphs.md) · [cookbook](../../docs/cookbook.md) · [API reference](../../docs/api.md).

## Rules the engine keeps
- Every state mutation goes through the RPC layer (journaled, persisted); all state work is serialized in one queue.
- Fake balances go in as EVM state (`sim.deal`, `sim.setState`, cheatcodes, impersonated txs), never as rewritten responses.
- Errors thrown to the dapp extend viem's `BaseError`, so viem treats them like a real node's (no retries on reverts).
- Fidelity is proven, not claimed: `npm run test:uniswap` in the repo root runs the same scenario here and on Anvil; `npm test` covers the rest.
