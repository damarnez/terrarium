# The first fifteen minutes

One screen, from an empty Vite project to your dapp swapping on the real Uniswap V2 with no node running. Everything here
links to the longer page that explains it. If your app is not on Vite, read this anyway and then take the
[integrations guide](integrations.md) for the mounting part.

## 1. Install (one minute)

```bash
npm install -D @terrariumlabs/core
```

That is the whole simulator: the chain engine (revm compiled to WebAssembly, pulled in as `@terrariumlabs/evm`), the scenario
runtime, the Vite plugin and the `terrarium` command line. Node 22 or newer, no Rust, no Docker, no RPC key.

## 2. Add the plugin (two minutes)

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { terrarium } from '@terrariumlabs/core/vite';

export default defineConfig({
  plugins: [react(), terrarium()],
  define: { 'process.env.DEBUG': 'undefined', 'process.env.TERRARIUM_DEBUG': 'undefined' },   // a dependency reads process.env in the browser
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
```

Add `.terrarium/` to `.gitignore`. Nothing in your `src/` changes, now or later: the plugin injects one script into `index.html`,
and `VITE_TERRARIUM=off` builds the plain dapp with not a byte of the simulator in it. Your dapp discovers "Terrarium Wallet"
the way it discovers MetaMask, through EIP-6963, the standard by which wallets announce themselves to a page.

## 3. Describe the chain (five minutes)

```ts
// terrarium.scenario.ts, in the project root
import { defineScenario } from '@terrariumlabs/core/scenario';
import uniswap from '@terrariumlabs/core/fixtures/uniswap-v2-mainnet.json';

export default defineScenario({
  name: 'Fresh pool',
  description: 'The real Uniswap V2 with ten ETH of liquidity in a new pair',
  persist: 'my-dapp',                              // the chain survives reloads under this key
  labels: { '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D': 'Uniswap V2 Router' },
  async setup(ctx) {
    await ctx.install(uniswap);                    // the mainnet bytecode of Router02, Factory and WETH9, at their mainnet addresses
    if (ctx.fresh) {                               // only on a brand-new chain: deploy your token, approve, add liquidity
      const treasury = ctx.wallet(ctx.accounts[9]);
      // await ctx.wait(treasury.deployContract({ abi, bytecode, args }));
      // await ctx.wait(treasury.writeContract({ address: ROUTER, abi: routerAbi, functionName: 'addLiquidityETH', args: [...], value: parseEther('10') }));
    }
  },
});
```

The scenario runs inside a Web Worker every time the page loads, before your dapp connects. `ctx.fresh` is true only on a chain
at block zero, so setup is safe to run on every boot. The ten accounts are the Anvil test accounts with 10,000 ETH each, and
`accounts[0]` is the user in the browser. Point your dapp's `.env` at the same addresses it would use on mainnet. Where the
bytes come from when the protocol is not Uniswap is the [tutorial's step 1](tutorial-new-protocol.md#1-get-the-protocol-in).

## 4. Run it (two minutes)

```bash
npm run dev
```

Open the page, click Connect, pick "Terrarium Wallet", and use your dapp. Every transaction is real EVM execution with real
receipts, gas and events, byte for byte what Anvil would produce.

## 5. Break things (five minutes)

The dark bar at the bottom is the dev bar, and if your scenario starts it collapsed you will find a leaf at the bottom right.
Mine a block. Open the Time menu and move the clock a day forward, then watch what your deadlines and oracles do. Take a
snapshot, swap, revert, and see the chain and your UI's history come back together. Make the wallet reject the next signature,
or answer in two seconds, or deliver receipts three seconds late. Open Transactions and read every call, event and revert,
decoded and named. When you have variants worth switching between, export a list of scenarios and the bar grows a selector,
each scenario keeping its own chain.

## Where to next

The [tutorial](tutorial-new-protocol.md) is the long version of this page: project anatomy, the three ways to get a protocol's
bytes in, compiling your own contracts, the four steps, troubleshooting. The [cookbook](cookbook.md) has one paste-able example
per feature. When your dapp reads a subgraph or an API, the [off-chain data guide](http-and-subgraphs.md) shows how the same
scenario answers those calls from the chain. The [API reference](api.md) has every option, method and flag.
