# Tutorial: test your dapp against a new protocol in four steps

You have a frontend for some protocol (a lending pool, a DEX, a vault). You want to click through it, run it in CI
and show it to people, without a node, an extension or test ETH. Four steps.

## 1. Get the protocol's bytecode (or fork the chain)

Two ways to get the real contracts into the Terrarium.

**A. Install bytecode fixtures** for protocols whose state you can bootstrap through their own functions (a DEX: you
create the pool yourself). Fetch the runtime code of the deployed contracts, byte for byte:

```bash
npx terrarium fetch-code router=0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D factory=0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f weth=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
  --rpc https://ethereum-rpc.publicnode.com --out fixtures/my-protocol.json
```
Keep the mainnet addresses: contracts usually have each other's addresses baked in as immutables. The Uniswap V2
fixture that ships with the package (`terrarium/fixtures/uniswap-v2-mainnet.json`) was made this way.

**B. Fork the chain** for protocols whose state you need as it is (a lending pool with real reserves, real oracles).
See `test/fork-record.mjs`: `createTerrarium({ chainId: 1, fork: { url, blockNumber } })`, run the interactions you
care about, `sim.dumpState()` is an offline fixture. `test/fork-offline.mjs` replays it with the network unplugged.

## 2. Write the scenario

`terrarium.scenario.ts` in your project root. It runs inside a Worker every time the page loads.

```ts
import { defineScenario } from 'terrarium/scenario';
import protocol from './fixtures/my-protocol.json';
import { MyToken } from './src/generated/contracts';   // your own contracts, compiled to abi + bytecode

export default defineScenario({
  chainId: 31337,
  seed: 1337,                 // reproducible actors
  persist: 'my-dapp',         // IndexedDB key; the chain survives reloads

  async setup(ctx) {
    await ctx.install(protocol);                                   // idempotent
    if (ctx.fresh) {                                               // first boot, or after "Reset"
      const deployer = ctx.wallet(ctx.accounts[9]);
      await ctx.wait(deployer.deployContract({ abi: MyToken.abi, bytecode: MyToken.bytecode, args: [...] }));
      // seed the protocol through its own functions: approve, addLiquidity, deposit, ...
    }
    ctx.state.pool = await ctx.pub.readContract({ ... });          // whatever the actors / dev bar need later
  },

  actors: [                                                         // other users, keepers, arbitrageurs (optional)
    { every: 5000, run: (ctx) => ctx.sim.sendAs(ctx.accounts[7], { to: ctx.state.pool, data: '0x...' }) },
    { on: (ctx) => ({ address: ctx.state.pool }), run: (ctx, log) => { /* react to an event */ } },
  ],
  actorsLabel: 'Other traders',
  status: (ctx) => ({ addresses: ctx.state }),                      // shows up in terrarium_status
});
```
Rule of thumb: leaf state (balances, allowances) may be written directly with `ctx.sim.deal` / `ctx.sim.setState`;
structural state (pool reserves, positions) must be produced by real transactions after dealing the inputs.

## 3. Point your dapp at the addresses and inject the Terrarium

Your dapp is configured like it would be for mainnet: a chain id and contract addresses in `.env`. Contract addresses
deployed by the scenario are deterministic (deployer account + nonce), so they can be committed.

```ts
// vite.config.ts
import { terrarium } from 'terrarium/vite';
export default defineConfig({ plugins: [react(), terrarium()] });   // terrarium({ scenario: 'other.scenario.ts' })
```
`npm run dev`. Your existing connect modal lists **Terrarium Wallet** (EIP-6963); the dev bar appears at the bottom.
Nothing in your `src/` changes. `VITE_TERRARIUM=off` builds the plain dapp.

## 4. Run it headless

```bash
VITE_TERRARIUM=off vite build      # the plain dapp
npx terrarium build                # dist-terrarium/terrarium.js: chain + wallet + dev bar in one script
```
```js
// Playwright
await page.addInitScript({ path: 'dist-terrarium/terrarium.js' });   // like installing a wallet extension
await page.goto(url);
await page.evaluate(() => window.terrarium.request('terrarium_setWallet', [{ rejectNext: 1 }]));   // make it misbehave
```
`e2e/frogpond.e2e.mjs` is a complete example: connect, approvals, a deposit with no funds, a rejected signature, a
slow wallet, swaps, snapshot and revert, reload, actors.

## Checking your numbers

The chain is real EVM execution of the real bytecode, so the protocol's own view functions are the oracle for your
frontend math: read them through `ctx.pub` or the dapp's client and compare. `npm run test:uniswap` shows the pattern
(router quote vs independent formula vs executed result), and proves the engine against Anvil.
