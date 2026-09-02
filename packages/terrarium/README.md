# terrarium

A complete EVM chain inside the page, presented to your dapp as an EIP-6963 wallet. Real bytecode execution (revm in
WebAssembly, or `@ethereumjs/vm`), real and verifiable blocks, receipts, logs and reverts, byte-identical to Anvil.
Your dapp does not know it is there.

## Entry points
| import | what |
|---|---|
| `terrarium` / `terrarium/engine` | `createTerrarium(options) → sim`, `indexedDBStorage()`, `TEST_KEYS` — the engine, usable in Node, Vitest, a Worker |
| `terrarium/scenario` | `defineScenario(config)` + types — what runs in the Worker when the page loads |
| `terrarium/worker` | `runScenario(config)` — the Worker runtime (boot, setup, actors, `terrarium_*` RPCs, provider bridge) |
| `terrarium/inject` | `startTerrarium(worker)` — page side: EIP-6963 announcement, `window.terrarium`, dev bar |
| `terrarium/vite` | `terrarium({ scenario? })` — Vite plugin: injects the whole thing into `index.html`; off with `VITE_TERRARIUM=off` |
| `terrarium/fixtures/uniswap-v2-mainnet.json` | mainnet runtime bytecode of Uniswap V2 Router02, Factory, WETH9, for `ctx.install()` |
| `npx terrarium build` / `npx terrarium fetch-code` | one injectable script for Playwright & co.; bytecode fixtures from any node |

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
export default defineConfig({ plugins: [react(), terrarium()] });
```
```js
// Playwright, against the dapp built with VITE_TERRARIUM=off
await page.addInitScript({ path: 'dist-terrarium/terrarium.js' });   // npx terrarium build
```

Full reference: [docs/api.md](../../docs/api.md). Tutorial: [docs/tutorial-new-protocol.md](../../docs/tutorial-new-protocol.md).

## Rules the engine keeps
- Every state mutation goes through the RPC layer (journaled, persisted); all state work is serialized in one queue.
- Fake balances go in as EVM state (`sim.deal`, `sim.setState`, cheatcodes, impersonated txs), never as rewritten responses.
- Errors thrown to the dapp extend viem's `BaseError`, so viem treats them like a real node's (no retries on reverts).
- Fidelity is proven, not claimed: `npm run test:uniswap` in the repo root runs the same scenario on both engines and on Anvil.
