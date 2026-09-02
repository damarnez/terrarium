# Tutorial: test your dapp against a new protocol in four steps

You have a frontend for some protocol (a lending pool, a DEX, a vault). You want to click through it, run it in CI
and show it to people, without a node, an extension or test ETH. Four steps: get the protocol's bytecode in, write a
scenario, inject the Terrarium into your dapp, run it headless. The finished versions of what this tutorial builds
are in this repo: Frogpond at the root (`terrarium.scenario.ts`, a DEX) and `examples/aave` / `examples/euler`
(lending, from recorded mainnet forks).

## Before you start

- **Node 22+**, a Vite dapp, and viem (or wagmi / ethers / RainbowKit / AppKit) discovering wallets through
  **EIP-6963**. If your connect modal lists MetaMask when it is installed, you are fine.
- The dapp is configured the way it would be for mainnet: a chain id and contract addresses in `.env`. Nothing in
  `src/` changes during this tutorial.
- **Ten accounts.** The Terrarium's wallet controls the ten Anvil / Hardhat test accounts (`0xf39F…2266`,
  `0x7099…79C8`, …), each with 10,000 ETH. Account 0 is "you" in the browser; use the others as deployer, treasury and
  actors. `ctx.accounts` lists them in the scenario, `terrarium_status` returns them to tests.
- **Your own contracts**, if you add any: the normal compiler artifact. `deployContract` needs `abi` + `bytecode`;
  installing code at a fixed address needs `deployedBytecode`; writing storage by variable name (`sim.setState`) needs
  `storageLayout` (Foundry: `extra_output = ["storageLayout"]` in `foundry.toml`; solc: add `storageLayout` to
  `outputSelection`). `scripts/build-contracts.mjs` in this repo does it with solc in 30 lines.

Two kinds of protocol, two ways in. Pick the one that matches yours:

| | **A. Install the bytecode** | **B. Record a fork** |
|---|---|---|
| when | the protocol's state can be bootstrapped through its own functions: a DEX (you create the pool), a factory, a registry, your own contracts | you need the state as it is on mainnet: a lending pool with real reserves and rates, real oracles, real risk parameters |
| what you fetch | the runtime code of a few contracts (`terrarium fetch-code`) | every account, code blob and storage slot a set of interactions touches (a `record.mjs` script) |
| result | a small JSON fixture; `ctx.install()` on every boot; the scenario deploys and seeds | a ≈0.5 MB fixture restored as the baseline; the chain starts at mainnet block N + 1, offline |
| example | Frogpond: real Uniswap V2 + your PEPE | `examples/aave`, `examples/euler` |

## 1. Get the protocol in

### A. Install bytecode fixtures

Fetch the runtime code of the deployed contracts, byte for byte, from any node:

```bash
npx terrarium fetch-code router=0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D factory=0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f weth=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 \
  --rpc https://ethereum-rpc.publicnode.com --out fixtures/my-protocol.json
```

The fixture is `{ contracts: { router: { address, code }, factory: {…}, weth: {…} }, source, blockNumber, fetchedAt }`.
**Keep the mainnet addresses**: contracts have each other's addresses baked in as immutables (the router knows its
factory and WETH; the factory derives pair addresses from its own address and its init code hash). The Uniswap V2
fixture that ships with the package (`terrarium/fixtures/uniswap-v2-mainnet.json`) was made exactly this way.

- `ctx.install(fixture)` writes code at each address only where there is none yet, so it is safe on every boot.
  Storage is not part of it: what a contract remembers (owner, fee settings, existing pairs) is whatever your scenario
  does next, through real transactions.
- A contract whose constructor set storage (an `owner`, an `initialized` flag, a fee recipient) arrives blank. Call its
  own functions to set it up if it has them (`initialize`), or write the variables directly:
  `ctx.sim.setState(address, storageLayout, { owner: ctx.accounts[9] })` with the layout, or
  `ctx.rpc('anvil_setStorageAt', [address, slot, value])` when you know the slot.

### B. Record a fork

A Node script forks mainnet lazily (state is fetched on first touch and recorded), prepares the user, takes a snapshot,
exercises everything the UI will do, reverts to the snapshot and dumps. `examples/aave/record.mjs` is the complete
version in 70 lines; the shape:

```js
import { createTerrarium } from 'terrarium/engine';
const RPC = process.env.FORK_RPC ?? 'https://ethereum-rpc.publicnode.com';
const blockNumber = Number(await remote('eth_blockNumber')) - 8;      // a few blocks back: past reorgs, still within non-archive state
const sim = await createTerrarium({ chainId: 1, fork: { url: RPC, blockNumber }, seed: 1 });
// viem clients on sim.provider, exactly as the examples do: pub (public client), w (wallet client for sim.accounts[0])

// 1. warm up every READ the UI does: reserve data, prices, decimals, symbols, balances, allowances
await pub.readContract({ address: pool, abi: poolAbi, functionName: 'getReserveData', args: [weth] });
// 2. the user's starting position, then a clean snapshot
await sim.deal(weth, user, parseEther('100'));
const clean = await sim.snapshot();
// 3. every WRITE path, time passing, and the failure paths your UI shows
await tx('approve WETH');  await tx('supply 10 WETH');  await tx('borrow 5,000 USDC');
await sim.provider.request({ method: 'evm_increaseTime', params: [3600] });  await sim.mine(1);
await tx('repay all');  await tx('withdraw all');
// 4. back to clean, dump: the user's position is gone, every remote read stays recorded
await sim.revert(clean);
const dump = await sim.dumpState();
writeFileSync('fixtures/my-protocol.json', JSON.stringify({ blockNumber, addresses, expected, dump }));
```

**What makes a fixture complete.** The dump holds every remote read the session made. At replay time the network is
forbidden: a read the fixture cannot answer is a *miss*, shown in the dev bar as `N MISSES`, listed in
`sim.offlineMisses`, and never fetched. So the recorder must take every path the UI and your tests will take:

- the view calls the UI polls, including for tokens the user does not hold yet and for positions that do not exist yet;
- every write, with amounts at least as large as the tests will use (larger amounts can touch more slots);
- time passing, at least as far as the tests travel: interest indexes and oracle heartbeats read slots idle state does not;
- `sim.deal` for every token the scenario will `deal` later (the balance slot is found by watching SLOADs; the probe's
  reads must be recorded too);
- the three storage slots of any oracle feed you plan to replace (the Aave recorder reads slots 0–2 of the Chainlink
  source so the scenario can restore them).

When in doubt, over-record; a slot costs about 150 bytes in the fixture. Put the numbers the recorder observed
(`expected`: health factor after the borrow, debt after an hour) in the fixture too: the offline test asserts against them.

## 2. Write the scenario

`terrarium.scenario.ts` in your project root. It runs inside a Worker every time the page loads, before your dapp
connects. It can read `import.meta.env.VITE_*`, so it can share addresses with the dapp's `.env`.

### A. A bootstrapped protocol

```ts
import { defineScenario } from 'terrarium/scenario';
import { getContractAddress, maxUint256, parseAbi, parseEther, type Address } from 'viem';
import protocol from './fixtures/my-protocol.json';
import { MyToken } from './src/generated/contracts';          // abi + bytecode, from your compiler

const ROUTER = protocol.contracts.router.address as Address;
const TOKEN = import.meta.env.VITE_TOKEN_ADDRESS as Address;    // the same address the dapp is configured with
const routerAbi = parseAbi(['function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable returns (uint256,uint256,uint256)']);

export default defineScenario({
  chainId: 31337,
  seed: 1337,                          // reproducible actors and ctx.random()
  persist: 'my-dapp',                  // IndexedDB key: the chain survives reloads; false = in-memory
  actorsLabel: 'Other traders',

  async setup(ctx) {
    await ctx.install(protocol);                                                 // idempotent
    if (ctx.fresh) {                                                             // block 0: first boot, or after Reset
      const deployer = ctx.wallet(ctx.accounts[9]);
      const expected = getContractAddress({ from: ctx.accounts[9], nonce: 0n });
      if (expected !== TOKEN) throw new Error(`MyToken deploys at ${expected}; set VITE_TOKEN_ADDRESS to it`);
      await ctx.wait(deployer.deployContract({ abi: MyToken.abi, bytecode: MyToken.bytecode, args: [parseEther('1000000000')] }));
      await ctx.wait(deployer.writeContract({ address: TOKEN, abi: MyToken.abi, functionName: 'approve', args: [ROUTER, maxUint256] }));
      await ctx.wait(deployer.writeContract({ address: ROUTER, abi: routerAbi, functionName: 'addLiquidityETH',
        args: [TOKEN, parseEther('8000000'), 0n, 0n, ctx.accounts[9], ctx.deadline()], value: parseEther('10') }));   // the pair exists now
      for (const a of ctx.accounts.slice(0, 9)) await ctx.wait(deployer.writeContract({ address: TOKEN, abi: MyToken.abi, functionName: 'transfer', args: [a, parseEther('50000000')] }));
    }
    ctx.state.pair = await ctx.pub.readContract({ /* factory.getPair(TOKEN, WETH) */ });   // what actors and status need later
  },

  actors: [
    { name: 'random trader', every: 5000, run: (ctx) => ctx.sim.sendAs(ctx.accounts[7], { to: ROUTER, value: '0x…', data: '0x…' }) },
    { name: 'arbitrageur', on: (ctx) => ({ address: ctx.state.pair, topics: [SWAP_TOPIC] }), run: (ctx, log) => { /* fade the swap */ } },
  ],
  status: (ctx) => ({ addresses: { router: ROUTER, token: TOKEN, pair: ctx.state.pair } }),   // merged into terrarium_status
});
```

What matters here:

- **Deploy once, on a fresh chain.** `ctx.fresh` is true when the chain has no blocks (first boot, or after the dev
  bar's Reset). Every later boot restores the chain from IndexedDB and skips the block.
- **Addresses are deterministic** (deployer address + nonce), so the dapp's `.env` can hold them like mainnet
  addresses. Deploy your contracts first, from a fixed account, in a fixed order; the `getContractAddress` check
  above turns a mistake into a message instead of a dapp that silently reads an empty address.
- **Leaf state may be written; structural state must be produced.** Balances and allowances: `ctx.sim.deal`,
  `ctx.sim.setState`, `anvil_setBalance`. Pool reserves, LP supply, positions, indexes: real transactions after dealing
  the inputs, or the protocol's invariants break in ways your UI will faithfully display.
- **Actors** are other users, keepers, arbitrageurs: `every` (ms) or `on` (a log filter, or a function of `ctx` when it
  depends on setup). They are toggled together in the dev bar, off by default, and their on/off state persists. Send
  their transactions with `ctx.sim.sendAs(address, tx)` (impersonation, no key needed) or `ctx.wallet(account)`.
  Randomness comes from `ctx.random()` so a seeded scenario replays identically.

### B. A forked protocol

```ts
import { defineScenario } from 'terrarium/scenario';
import fixture from './fixtures/my-protocol.json';
import { FixedPriceFeed } from './src/generated/contracts';   // deployedBytecode + storageLayout

const forkRpc = import.meta.env.VITE_FORK_RPC || undefined;

export default defineScenario({
  chainId: 1,
  seed: 7,
  persist: `my-dapp-${fixture.blockNumber}`,                                   // keyed by the fixture: a re-recorded fixture starts fresh
  fork: { url: forkRpc, blockNumber: fixture.blockNumber, offline: !forkRpc },  // offline by default: every read comes from the fixture
  restore: fixture.dump,                                                        // the baseline when nothing is persisted yet
  clock: 'recording',                                                           // the chain clock continues from the recorded moment

  async setup(ctx) {
    if (ctx.firstBoot) await ctx.sim.deal(fixture.addresses.usdc, ctx.accounts[0], 1_000n * 10n ** 6n);   // once, on top of the fixture
  },

  methods: {
    async terrarium_ethPrice(ctx, pct: number) {                               // any terrarium_* method, reachable via the provider
      const src = fixture.addresses.ethSource;                                 // the Chainlink aggregator Aave's oracle reads
      await ctx.rpc('anvil_setCode', [src, FixedPriceFeed.deployedBytecode]);  // a fixed feed AT THE SAME ADDRESS: every consumer keeps reading "the oracle"
      await ctx.sim.setState(src, FixedPriceFeed.storageLayout, { answer: (BigInt(fixture.expected.ethPrice) * BigInt(100 + pct)) / 100n, decimals: 8, roundId: 1 });
      await ctx.rpc('evm_mine');                                               // a new block, so the UI notices
    },
  },
  controls: [                                                                  // extra dev-bar buttons
    { label: 'ETH −30%', method: 'terrarium_ethPrice', params: [-30], title: 'Crash the ETH price 30 % below the recorded price' },
    { label: 'ETH −60%', method: 'terrarium_ethPrice', params: [-60] },
  ],
  status: () => ({ addresses: fixture.addresses, forkBlock: fixture.blockNumber }),
});
```

What matters here:

- **`fork` + `restore` + `offline`.** The fixture's dump is the baseline; `offline: true` turns every read the fixture
  cannot answer into an error and a `MISSES` counter instead of a network call. Keep `VITE_FORK_RPC` as an escape
  hatch: set it and the same scenario forks online, fetching whatever the fixture lacks (and telling you what to
  record next).
- **`firstBoot`, not `fresh`.** A forked chain starts at block N + 1, so `ctx.fresh` (block 0) is never true. `ctx.firstBoot`
  is true when nothing is persisted yet, even though the fixture was restored: that is when you `deal` the user their
  starting balances on top of the recording.
- **Key `persist` by the fixture's block.** A persisted chain wins over `restore`; without the block number in the key a
  re-recorded fixture never loads.
- **`clock: 'recording'`.** The wall clock re-based to the fixture's last block, so the chain time continues from the
  recorded moment however long ago you recorded. Oracles with staleness checks keep working; interest accrues from where
  it was. The dev bar's +1 hour still moves time, and a forked oracle reverting with `PriceOracle_TooStale` after that is
  the real failure mode, worth seeing.
- **`methods` + `controls`** are how scenario-specific knobs reach the dev bar and tests: an RPC method that mutates
  EVM state (never one that rewrites responses), and a button that calls it.

### What `ctx` gives you

| member | use |
|---|---|
| `accounts` | the ten addresses; `accounts[0]` is the user in the browser |
| `pub`, `wallet(account)` | viem public and wallet clients on the chain; `wait(hashOrPromise)` for a receipt |
| `sim` | the engine: `deal`, `setState`, `sendAs`, `snapshot`/`revert`, `mine`, `now()`, `random()` |
| `rpc(method, params)` | any RPC method including cheatcodes (`anvil_setCode`, `evm_increaseTime`, …) |
| `install(fixture)`, `codeAt(address)` | bytecode fixtures in; "is anything deployed here?" |
| `deadline(seconds)` | a deadline from the **chain** clock (never `Date.now()`) |
| `fresh`, `firstBoot` | block 0 (deploy here) / nothing persisted yet (seed the user here) |
| `state` | a bag for what setup discovers and actors, `methods` and `status` need later |

Everything else: [api.md](api.md).

## 3. Point your dapp at the addresses and inject the Terrarium

Your dapp is configured the way it would be for mainnet: `.env` holds the chain id and the addresses (the fixed mainnet
ones, and the deterministic ones your scenario deploys). Then one plugin:

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { terrarium } from 'terrarium/vite';

export default defineConfig({
  plugins: [react(), terrarium()],                 // terrarium({ scenario: 'other.scenario.ts' }) for another file
  define: { 'process.env.DEBUG': 'undefined', 'process.env.TERRARIUM_DEBUG': 'undefined' },   // ethereumjs depends on `debug`, which reads process.env in the browser
  build: { target: 'es2022' },                      // bigint literals, top-level await
  worker: { format: 'es' },                         // the chain runs in a module Worker
});
```

Add `.terrarium/` to `.gitignore` (the plugin generates two small entry files there). Then:

```bash
npm run dev
```

Your existing connect modal lists **Terrarium Wallet**; connect, and the dapp is talking to the chain in the Worker.
The dark bar at the bottom is the dev bar:

| button | what it does |
|---|---|
| block counter, engine, fork | live status: chain id, head block, `revm/wasm` or `ethereumjs`, fork block and `MISSES` if any, "N local blocks restored" after a reload |
| **Mine a block**, **+1 hour** | one empty block; `evm_increaseTime(3600)` + a block. Interest accrues, deadlines expire, oracles go stale |
| **Blocks: instant / every 3s** | a block per transaction, or interval mining so you can watch pending states |
| **Snapshot / Revert** | `evm_snapshot` / `evm_revert`: state, blocks, receipts, logs, the clock and the UI's history all come back |
| **Actors** (your `actorsLabel`) | start and stop the scenario's actors; persisted |
| **Reject next tx**, **Wallet: 2s delay**, **Receipts: 3s late** | the wallet says no (EIP-1193 code 4001), answers slowly, or the node lags behind the block |
| your `controls` | whatever the scenario declared |
| **Reset** | wipe the persisted chain and reload: `setup` runs on a fresh chain again |

Nothing in `src/` changes. `VITE_TERRARIUM=off` (in `.env` or the environment) builds and serves the plain dapp,
with not one byte of the Terrarium in it.

## 4. Run it headless

### In the browser (Playwright)

```bash
VITE_TERRARIUM=off vite build      # the plain dapp, exactly what you ship
npx terrarium build                # dist-terrarium/terrarium.js: chain + wallet + dev bar in one script
```
```js
await page.addInitScript({ path: 'dist-terrarium/terrarium.js' });         // like installing a wallet extension
await page.goto(url);
const rpc = (method, params = []) => page.evaluate(([m, p]) => window.terrarium.request(m, p), [method, params]);
const status = await rpc('terrarium_status');                                // addresses from your status(), accounts, block
await page.getByTestId('connect').click();                                   // your dapp's picker...
await page.getByTestId('wallet-dev.terrarium').click();                      // ...lists the Terrarium by its rdns
await rpc('terrarium_setWallet', [{ rejectNext: 1 }]);                       // the next signature is refused: what does the UI say?
await rpc('sim_deal', [status.addresses.token, status.accounts[0], '0x0']);  // the user's tokens vanish behind the UI's back
await page.getByTestId('plus-hour').click();                                 // the dev bar is scriptable too (data-testids in api.md)
```

`e2e/frogpond.e2e.mjs` is a complete example: connect, approvals, a deposit with no funds (the real router's
`TransferHelper: TRANSFER_FROM_FAILED`, decoded), a rejected signature, a slow wallet, swaps both ways, snapshot and
revert, reload, actors, and an assertion that the dapp's bundle contains no simulator chunk.

### In Node (the engine directly)

The scenario file is for the page. For unit-level checks of your frontend math, drive the engine with the same fixture
from a Node script, with the network forbidden. `examples/aave/test.mjs`:

```js
import { createTerrarium } from 'terrarium/engine';
globalThis.fetch = async (url) => { throw new Error(`offline: ${url}`); };                 // any network attempt fails the test
const sim = await createTerrarium({ chainId: 1,
  fork: { blockNumber: fixture.blockNumber, offline: true }, restore: fixture.dump, seed: 1, clock: () => anchor });
// viem clients on sim.provider; then: supply, borrow, read getUserAccountData, compare with what the UI computes
const clientHf = Number(collateral * liqThreshold) / 10000 / Number(debt);
ok &&= Math.abs(contractHf - clientHf) < 1e-6 && sim.offlineMisses.length === 0;
```

`npm run test:examples` runs both examples this way. A `clock` that returns the fixture's last block timestamp is the
Node equivalent of `clock: 'recording'`. For the engine's own behaviour (cheatcodes, snapshots, filters, persistence,
fork misses) see `test/unit/*.test.mjs`: sixty small tests on the same primitives, a good place to copy from.

## Scenarios worth writing

The README's table of use cases lists what frontends usually get wrong; each row is a few lines of scenario. The recipe
is always the same: put the chain in the interesting state with the primitives above, then look at the UI.

- **Preloaded liquidation.** In `setup`, after the fixture: `deal` collateral, supply, borrow to the limit through the
  protocol (real transactions, so indexes and events are right), then a control that moves the oracle. Or an actor
  that waits for the price move and liquidates the user from another account.
- **Bad oracle.** The fixed feed pattern with a zero, negative or absurd `answer`; a `roundId` and timestamp hours in
  the past; or just **+1 hour** on a fork whose adapters check staleness.
- **Illiquidity.** Impersonate a whale (any address works with `sendAs`; `deal` it the tokens) and borrow or withdraw
  the pool dry, then let the user try. On a DEX, have the treasury remove most of the liquidity.
- **Front-run / slippage.** An actor with `on: { address: pair, topics: [SWAP] }` that trades in the block after every
  user swap, or an `every` actor that moves the price every few seconds.
- **Parameter changes.** `setState` on the protocol's configuration by storage layout, or impersonate the admin and call
  the real setter; then check what the UI cached.
- **The human side.** Reject, delay and lag from the dev bar or `terrarium_setWallet`, in the middle of a multi-step flow.

## Two rules for the dapp side

- **Deadlines and anything time-based come from the pending block**: `getBlock({ blockTag: 'pending' })`. `latest` can
  be hours old on an idle chain (the real Uniswap router answered `EXPIRED` after an idle hour) and `Date.now()` is wrong
  once the dev bar shifts the clock. This is also the right thing to do against a real node.
- **Your dapp must not know the Terrarium exists.** Configure it with a chain id and addresses, discover wallets with
  EIP-6963, and keep every test hook on the Terrarium side: `window.terrarium`, `terrarium_*` methods, the dev bar.
  The moment `src/` special-cases the Terrarium, you are testing something other than what you ship.

## Checking your numbers

The chain is real EVM execution of the real bytecode, so the protocol's own view functions are the oracle for your
frontend math: read them through `ctx.pub` in the scenario, the viem client in a Node test, or the dapp itself, and
compare. The Aave example shows the Pool's health factor next to the UI's, with a check mark when they agree to 1e-6;
its test asserts the same, then halves the ETH price and asserts again. `npm run test:uniswap` shows the pattern for a
DEX (router quote vs the constant-product formula vs the executed result) and proves the engine itself against Anvil.

## Troubleshooting

| symptom | cause | fix |
|---|---|---|
| dev bar shows `N MISSES`; a read fails with `OfflineStateError` | the fixture lacks a slot the UI or test reads | warm that read in `record.mjs`, re-record; or set `VITE_FORK_RPC` to run online and see what is fetched |
| `process is not defined` in the browser console | Vite does not polyfill `process`; ethereumjs' `debug` dependency reads it | the `define` block in `vite.config.ts` above |
| the scenario deploys again on every reload | `persist: false`, or deploying without a `fresh` / `codeAt` guard | guard with `ctx.fresh` (or `codeAt(addr) === '0x'`); keep `persist` on |
| in a fork scenario, a `ctx.fresh` block never runs | a forked chain starts at block N + 1 | use `ctx.firstBoot` |
| `MyToken would deploy at 0x…; reset` (or the dapp reads an empty address) | the deployer's nonce moved: an older persisted chain, or an extra tx before the deploy | dev bar → Reset; deploy from a fixed account in a fixed order |
| a re-recorded fixture is ignored | a persisted chain wins over `restore` | key `persist` by `fixture.blockNumber` |
| the router says `EXPIRED`; a permit's deadline is in the past | deadline from `latest` or `Date.now()` | derive it from the `pending` block |
| after **+1 hour** on a fork, pricing reverts (`PriceOracle_TooStale` and the like) | the recorded oracle round is now older than the adapter's heartbeat; Anvil does the same | expected; revert the snapshot or move time back (`evm_increaseTime` accepts negative values); keep `clock: 'recording'` for the baseline |
| `no key for 0x…; call anvil_impersonateAccount first` | a tx from an address the wallet has no key for | `ctx.sim.sendAs(address, tx)`, or one of the ten accounts through `ctx.wallet` |
| `no direct storage slot for this read` from `deal` | the token's balance is computed (rebasing, shares) rather than stored | impersonate a holder or the minter and transfer/mint instead |
| you want to mock a contract in JavaScript | there is no JS mock; the chain runs bytecode only | install a small Solidity stand-in at the address (`anvil_setCode`) and set its variables with `setState`, like the price feed above |
| `[terrarium] actor … failed:` in the console | an actor's `run` threw; actors never crash the chain | read the message; usually a stale address in `ctx.state` or a missing approval |
| the page reloads but old history is back | that is persistence working | dev bar → Reset for a clean chain; `persist: false` for tests that must start empty |

## Where to look next

- [api.md](api.md): every option, `sim` member, RPC method, scenario field, plugin option, CLI command and dev bar test id.
- `terrarium.scenario.ts`, `examples/aave/`, `examples/euler/`: three finished scenarios, two recorders, two offline tests.
- `e2e/frogpond.e2e.mjs`: the browser flow, end to end.
