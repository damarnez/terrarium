# Cookbook: every feature, one example

← [Docs index](README.md) · [Tutorial](tutorial-new-protocol.md) · [Off-chain data](http-and-subgraphs.md) · [API reference](api.md)

Each recipe is a few lines you can paste into a scenario (`ctx` is the scenario context), a Node script (`sim` from
`createTerrarium`) or a Playwright test (`rpc` = `window.terrarium.request`). The three are the same chain behind the
same RPC surface, so a recipe written for one works in the others with the obvious renaming: `ctx.rpc(m, p)` ≡
`sim.provider.request({ method: m, params: p })` ≡ `rpc(m, p)`.

**Contents**
1. [Money: balances, tokens, allowances](#1-money-balances-tokens-allowances)
2. [Storage by variable name](#2-storage-by-variable-name)
3. [Code at an address: stand-ins and upgrades](#3-code-at-an-address-stand-ins-and-upgrades)
4. [Acting as someone else](#4-acting-as-someone-else)
5. [Time](#5-time)
6. [Blocks and mining](#6-blocks-and-mining)
7. [Snapshots](#7-snapshots)
8. [Logs, filters, subscriptions](#8-logs-filters-subscriptions)
9. [Actors: other people on the chain](#9-actors-other-people-on-the-chain)
10. [The wallet misbehaving](#10-the-wallet-misbehaving)
11. [Gas](#11-gas)
12. [What-if calls: state overrides](#12-what-if-calls-state-overrides)
13. [Persistence, reset, first boot](#13-persistence-reset-first-boot)
14. [Forks: online, offline, recorded](#14-forks-online-offline-recorded)
15. [Following a live chain](#15-following-a-live-chain)
16. [Off-chain data: APIs and subgraphs](#16-off-chain-data-apis-and-subgraphs)
17. [Your own buttons and RPC methods](#17-your-own-buttons-and-rpc-methods)
18. [Reading status from tests](#18-reading-status-from-tests)
19. [The engine in Node and in Vitest](#19-the-engine-in-node-and-in-vitest)
20. [The wallet vs the node view](#20-the-wallet-vs-the-node-view)
21. [Randomness that replays](#21-randomness-that-replays)
22. [Proving a block is real](#22-proving-a-block-is-real)
23. [React without the Vite plugin](#23-react-without-the-vite-plugin)
24. [The transaction explorer](#24-the-transaction-explorer)
25. [wagmi: reads on the Terrarium chain](#25-wagmi-reads-on-the-terrarium-chain)
26. [Several scenarios](#26-several-scenarios)

The rule behind all of them: **write leaf state, produce structural state.** Balances, allowances, an oracle answer,
a config flag can be written directly. Pool reserves, positions, interest indexes, LP supply must be produced by real
transactions, or the protocol's invariants break in ways your UI will faithfully display.

## 1. Money: balances, tokens, allowances

```ts
await ctx.rpc('anvil_setBalance', [user, toHex(parseEther('100'))]);            // ETH
await ctx.sim.deal(USDC, user, 5_000n * 10n ** 6n);                              // any ERC20, proxies included: finds the balance slot by watching SLOADs
await ctx.sim.deal(USDC, user, 0n);                                              // …and takes it away again (the e2e does this mid-flow)
await ctx.wait(ctx.wallet(user).writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [POOL, maxUint256] }));   // allowances: a real tx, so Approval is emitted
```

`deal` adjusts `totalSupply` too (pass `{ adjustTotalSupply: false }` to leave it). It throws `no direct storage slot` for
tokens whose balance is computed (rebasing tokens, vault shares): impersonate a holder and transfer, or mint through
the protocol. From a test: `rpc('sim_deal', [token, holder, '0x0'])`.

## 2. Storage by variable name

```ts
// the compiler's storageLayout (see the tutorial's "Compiling your own contracts") names slots for you
await ctx.sim.setState(FEED, FixedPriceFeed.storageLayout, { answer: 1_800n * 10n ** 8n, decimals: 8, roundId: 1 });
await ctx.sim.setState(TOKEN, MyToken.storageLayout, { owner: ctx.accounts[9], paused: true, balances: { [user]: parseEther('1') } });   // mappings: nested objects
await ctx.rpc('anvil_setStorageAt', [addr, '0x3', pad('0x01', { size: 32 })]);    // when you know the slot
const slot = ctx.sim.slotFromLayout(layout, ['balances', user]);                   // just compute the slot
```

Scalars, mappings with address / uint / bytes32 / string keys and dynamic arrays are supported; packed variables are not
(write the whole slot with `anvil_setStorageAt`). Governance-style scenarios live here: flip a pause flag, change a
reserve factor, lower an LTV, then see what the UI cached.

## 3. Code at an address: stand-ins and upgrades

```ts
await ctx.install(fixture);                                                       // runtime code from `terrarium fetch-code`, only where nothing is deployed yet
await ctx.rpc('anvil_setCode', [CHAINLINK_ETH_USD, FixedPriceFeed.deployedBytecode]);   // a stand-in at the real address: every consumer keeps reading "the oracle"
await ctx.sim.setState(CHAINLINK_ETH_USD, FixedPriceFeed.storageLayout, { answer: 900n * 10n ** 8n, decimals: 8, roundId: 1 });
const original = await ctx.codeAt(CHAINLINK_ETH_USD);                             // remember it, put it back later
```

Use `deployedBytecode`, never `bytecode` (creation code) here: no constructor runs, so set what the constructor would
have set with `setState`. This is the only kind of "mock" that exists: bytecode at an address. There is no JavaScript
mock of a contract, on purpose.

### A whole deployment from Anvil

Your protocol has its own deploy tooling (a Foundry script that wires twenty contracts, a Hardhat deploy). Do not rewrite
it for the Terrarium: run it against Anvil, dump, import, install.

```sh
anvil &                                              # chain 31337
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $ANVIL_KEY_0
npx terrarium import-anvil --rpc http://127.0.0.1:8545 --out fixtures/protocol.json \
  --broadcast broadcast/Deploy.s.sol/31337/run-latest.json --artifacts out     # + contract names and ABIs for the explorer
```
```ts
import protocol from './fixtures/protocol.json';
async setup(ctx) { await ctx.install(protocol); }    // code, storage, nonces, balances; safe on every boot
```

Contracts land once (an address that already has code is skipped); plain accounts (the deployer's nonce, funded EOAs)
only on a fresh chain. Anvil's ten test accounts are the Terrarium's own, so deploying from account #0 means "You" own
the protocol in the page. Under the hood it is one `anvil_loadState` call, the same cheatcode Anvil has:
`ctx.rpc('anvil_loadState', [dump])` takes the gzipped hex `anvil_dumpState` answers or the parsed object.

## 4. Acting as someone else

```ts
await ctx.sim.sendAs(WHALE, { to: POOL, data: encodeFunctionData({ abi: poolAbi, functionName: 'withdraw', args: [WETH, maxUint256, WHALE] }) });   // no key needed
await ctx.rpc('anvil_impersonateAccount', [ADMIN]);                               // …or the Anvil way, then eth_sendTransaction from ADMIN
await ctx.rpc('eth_sendTransaction', [{ from: ADMIN, to: POOL, data: setterCalldata }]);
await ctx.rpc('anvil_stopImpersonatingAccount', [ADMIN]);
```

Impersonated transactions carry an Anvil-style fake signature, so they hash, RLP and appear in blocks like any other.
Drain a pool as a whale, call an admin setter, liquidate the user from a keeper account: this is how.

## 5. Time

```ts
await ctx.rpc('evm_increaseTime', [3600]); await ctx.rpc('evm_mine');            // an hour later (negative values allowed)
await ctx.rpc('evm_setNextBlockTimestamp', [Number(ctx.sim.now()) + 86_400]);     // the next block at an exact time
const deadline = ctx.deadline(600);                                               // 10 minutes from the CHAIN clock, for router / permit deadlines
```

Three clock modes in `defineScenario`: `'wall'` (default), `'recording'` (the wall clock re-based to a restored fixture's
last block, so recorded oracles stay fresh however old the fixture is), or a number (fixed; blocks then advance one
second at a time). In Node: `createTerrarium({ clock: () => seconds })`. Never `Date.now()` in a scenario or a dapp:
the dev bar's **+1 hour** moves the chain clock, not the wall.

```mermaid
flowchart LR
  wall["wall clock<br/>Date.now()"] --> off["+ timeOffset<br/>(evm_increaseTime, dev bar +1 h)"] --> ts["block.timestamp<br/>(at least +1 s per block)"]
  rec["'recording': re-based to the<br/>fixture's last block"] --> off
  fixed["a number: stands still"] --> off
```

## 6. Blocks and mining

```ts
await ctx.rpc('evm_mine');                                                        // one empty block (also anvil_mine / hardhat_mine [n])
await ctx.rpc('evm_setAutomine', [false]); await ctx.rpc('evm_setIntervalMining', [3000]);   // a block every 3 s: pending states become visible
await ctx.rpc('evm_setAutomine', [true]);                                         // back to a block per transaction
const pending = await ctx.pub.getBlock({ blockTag: 'pending' });                  // the next block: real number and timestamp, the mempool as transactions
```

The dev bar's **Blocks: instant / every 3s** toggles the same two calls. Gas is estimated against the pending block,
like geth, which is why `deadline` and anything time-based should come from it too.

## 7. Snapshots

```ts
const id = await ctx.rpc('evm_snapshot');
// …swap, borrow, crash the price…
await ctx.rpc('evm_revert', [id]);                                                // state, blocks, receipts, logs, filter cursors, the clock and the base fee all come back
```

A revert moves the head *backwards*. viem's `watchBlockNumber` ignores that, so a dapp should poll the head and reload
its history when the number drops or the hash changes (Frogpond's `usePond.ts` does). The recorders use snapshots to
exercise a protocol and dump a clean fixture afterwards.

## 8. Logs, filters, subscriptions

```ts
const swaps = await ctx.pub.getContractEvents({ address: PAIR, abi: pairAbi, eventName: 'Swap', fromBlock: 0n, strict: true });
const id = await ctx.rpc('eth_newFilter', [{ address: PAIR, topics: [SWAP_TOPIC] }]);
const fresh = await ctx.rpc('eth_getFilterChanges', [id]);                        // cursors survive snapshot reverts (clamped)
const unsubscribe = ctx.sim.onLog({ address: PAIR, topics: [SWAP_TOPIC] }, (log, { blockNumber }) => { /* runs after the block is sealed */ });
```

`eth_subscribe('newHeads')` answers and new heads arrive as EIP-1193 `message` events; viem's `custom` transport polls
anyway. Blooms are real, so a client filtering by bloom gets the same answers it would from a node.

## 9. Actors: other people on the chain

```ts
actors: [
  { name: 'random trader', every: 5000, run: async (ctx) => ctx.sim.sendAs(ctx.accounts[7], { to: ROUTER, value: toHex(parseEther('0.1')), data: buyCalldata(ctx) }) },
  { name: 'arbitrageur', on: (ctx) => ({ address: ctx.state.pair, topics: [SWAP_TOPIC] }), run: async (ctx, log) => { /* fade the swap a block later */ } },
  { name: 'liquidator', on: { address: ORACLE, topics: [ANSWER_UPDATED] }, run: async (ctx) => { /* liquidationCall from a funded keeper */ } },
],
actorsLabel: 'Pond life',
```

Off by default, toggled together (dev bar button, or `terrarium_actors(on?)`), their on/off state persists. A throwing
actor is logged as `[terrarium] actor … failed`, never fatal. Use `ctx.random()` for anything random so a seeded
scenario replays identically.

An actor the protocol cannot work without is not "other people": a keeper that answers a mock oracle's requests, a
relayer that executes queued orders. Give it `always: true` and it runs from the first boot, outside the toggle, so the
dapp works before anyone finds a button; the toggle button stays for the actors that are optional (and disappears when
none are).

```ts
actors: [
  { name: 'oracle keeper', always: true, on: { address: ORACLE, topics: [REQUEST_SENT] }, run: async (ctx, log) => {
    const { args } = decodeEventLog({ abi: oracleAbi, eventName: 'RequestSent', data: log.data, topics: log.topics });
    if (ctx.state.oracle === 'down') return;                                    // a dev-bar button flips this: the refund path
    await ctx.sim.sendAs(ctx.accounts[8], { to: ORACLE, data: encodeFunctionData({ abi: oracleAbi, functionName: 'fulfill', args: [args.requestId] }) });
  } },
],
```

## 10. The wallet misbehaving

```ts
await rpc('terrarium_setWallet', [{ rejectNext: 1 }]);          // the next signature request fails with EIP-1193 4001 ("user rejected")
await rpc('terrarium_setWallet', [{ latencyMs: 2000 }]);        // every wallet method takes 2 s: pending states, double-click guards
await rpc('terrarium_setWallet', [{ receiptLagMs: 3000 }]);     // receipts appear 3 s after the block: "confirming…" that resolves late
const knobs = await rpc('terrarium_getWallet');
```

Same knobs as the dev bar's **Reject next tx / Wallet: 2s delay / Receipts: 3s late**, and as `wallet: { … }` in
`defineScenario` for a scenario that starts hostile. Reads are never delayed: the gate sits before the state lock.

## 11. Gas

```ts
gasEstimation: 'fast'                                                             // in defineScenario or createTerrarium: no estimation, block gas limit (CI speed)
const gas = await ctx.pub.estimateContractGas({ address: ROUTER, abi: routerAbi, functionName: 'swapExactETHForTokens', args, value, account: user });   // the search the reth node uses, run inside the wasm against the pending block
```

A transaction a node would refuse (bad nonce, insufficient funds) gets a **failed receipt** with `droppedReason` instead of
vanishing, so `waitForTransactionReceipt` never hangs.

## 12. What-if calls: state overrides

```ts
// "what would this call return if the user had 1,000 WETH?" — without touching the chain
const out = await ctx.rpc('eth_call', [{ to: POOL, data }, 'latest', { [WETH]: { stateDiff: { [balanceSlot]: pad(toHex(parseEther('1000')), { size: 32 }) } } }]);
const rev = await ctx.rpc('eth_call', [{ to: TARGET, data: '0x' }, 'latest', { [TARGET]: { code: '0x60006000fd' } }]);   // run other code at an address for one call
```

The third `eth_call` parameter is a geth state-override set (`balance`, `nonce`, `code`, `state`, `stateDiff`). viem's
`simulateContract({ stateOverride })` uses it.

## 13. Persistence, reset, first boot

```ts
persist: `my-dapp-${fixture.blockNumber}`,    // IndexedDB key; false = in-memory. Key by fixture block so a re-recorded fixture starts fresh
async setup(ctx) {
  if (ctx.fresh) { /* block 0: deploy and seed (first boot, or after Reset) */ }
  if (ctx.firstBoot) { /* nothing persisted yet, even if a fixture was restored: deal the user their starting balances */ }
}
```

Reload the page: the chain, receipts and history are back. `terrarium_reset()` (dev bar **Reset**) stops actors, clears
the origin's IndexedDB store and the dev bar reloads; `setup` then runs on a fresh chain. In Node, `persist` takes any
`{ getItem, setItem, removeItem }` store and `sim.dumpState()` / `loadState(dump)` are the primitives. Saves are incremental: blocks go
into chunks of 64 under `<key>:b<i>` and only the chunks that changed are rewritten, so a save costs the same at block 3000 as at
block 30. A value saved by a version before 0.7 (the whole dump under the key) still loads and is converted on its next save.

## 14. Forks: online, offline, recorded

```ts
// online: lazy reads from a node, recorded as they happen (the recorders' mode)
const sim = await createTerrarium({ chainId: 1, fork: { url: RPC, blockNumber: 21_000_000 } });
// offline: the fixture is the truth; a read it cannot answer throws OfflineStateError and shows up as a MISS
fork: { blockNumber: fixture.blockNumber, offline: true }, restore: fixture.dump, clock: 'recording'
// the escape hatch: the same scenario online when VITE_FORK_RPC is set
fork: { url: import.meta.env.VITE_FORK_RPC || undefined, blockNumber: fixture.blockNumber, offline: !import.meta.env.VITE_FORK_RPC }
sim.offlineMisses                                                                 // [{ kind: 'storage', key: '0x…:0x…' }]: what to warm in the recorder
```

Record with `npx terrarium record … --block N --chain 1 --script warm.mjs` (tutorial step 1B). A forked chain starts at
block N + 1, so `ctx.fresh` is never true there; use `ctx.firstBoot`.

## 15. Following a live chain

```ts
sim.followChain(RPC, { pollMs: 4000, onBlock: (n) => console.log('head', n) });   // mirror a live chain's block numbers and timestamps
sim.stop();                                                                       // stop timers and persistence
```

For demos that should feel like they run "on" a chain whose head keeps moving while the state is local.

## 16. Off-chain data: APIs and subgraphs

```ts
http: [
  { match: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2', graphql: { swaps: (ctx, q) => swapsFromLogs(ctx, q), pair: (ctx, q) => pairFromReserves(ctx, q) } },
  { match: 'https://api.coingecko.com/api/v3/simple/price*', handler: () => ({ ethereum: { usd: 2000 } }) },
  { match: 'https://backend.example/', handler: () => reply({ message: 'maintenance' }, { status: 503 }) },
],
```

The dapp's `fetch` to those URLs is answered from the Worker; everything else goes to the network. The whole story, with
the failure modes (down, behind, slow) and the Frogpond example: [http-and-subgraphs.md](http-and-subgraphs.md).

## 17. Your own buttons and RPC methods

```ts
methods: {
  async terrarium_ethPrice(ctx, pct: number) { /* install the fixed feed, set answer, evm_mine */ return pct; },
  async terrarium_faucet(ctx, to: Address) { await ctx.sim.deal(USDC, to, 10_000n * 10n ** 6n); },
},
controls: [
  { label: 'ETH −30%', method: 'terrarium_ethPrice', params: [-30], title: 'Crash the ETH price 30 % below the recorded price' },
  { label: 'Mine 10 blocks', method: 'anvil_mine', params: [10] },                // any RPC method works as a button
],
```

Methods receive `ctx` then the params, are reachable through the provider (`rpc('terrarium_ethPrice', [-30])`) and run
outside the state lock, so they can call other RPC methods. They mutate EVM state; they never rewrite responses. The dev
bar renders `controls` in order as `control-0`, `control-1`, … for tests.

> [!TIP]
> Since 0.5 a scenario file can export a list (recipe 26): each variant keeps its own chain and the dev bar switches between them,
> which covers most of what this recipe hand-rolls. Keep reading for the general shape of a method that rebuilds the chain.

A button that rebuilds the world (pick a use case, start from another fixture) resets the chain, and the dapp on top of
it has to start over too. `ctx.reload()` asks the page to reload once the method has done its work; the dev bar's own
Reset button does the same thing for its reset. Keep the choice somewhere Reset does not wipe (its own IndexedDB store,
not the chain's) and read it back in `setup()`:

```ts
import { indexedDBStorage } from '@terrariumlabs/core';
const settings = indexedDBStorage('my-dapp-terrarium');           // its own store: untouched by terrarium_reset, which removes only the chain's keys
methods: {
  async terrarium_useCase(ctx, id: string) { await settings.setItem('useCase', id); await ctx.rpc('terrarium_reset'); ctx.reload(); },
},
async setup(ctx) { const useCase = (await settings.getItem('useCase')) ?? 'default'; if (ctx.fresh) await seed(ctx, useCase); },
controls: [{ label: 'Use case: all in one vault', method: 'terrarium_useCase', params: ['all-in-one-vault'] }],
```

## 18. Reading status from tests

```js
const st = await rpc('terrarium_status');
// { scenario, now: '0x…' (the chain clock), txs: { total, pending, failed }, chainId, engine: 'revm', block: '0x…', accounts, actors, actorsLabel,
//   hasActors, wallet: { rejectNext, latencyMs, receiptLagMs }, controls, restoredFromPersistence, localBlocks,
//   fork: null | { blockNumber, offline, misses }, http: { routes, hits }, ...status(ctx) }
```

Put the addresses your scenario deployed or discovered in `status(ctx)`; tests read them instead of hard-coding.

## 19. The engine in Node and in Vitest

```js
import { createTerrarium } from '@terrariumlabs/core/engine';
const sim = await createTerrarium({ chainId: 31337, seed: 1, clock: () => 1_700_000_000 });   // deterministic blocks
const pub = createPublicClient({ chain, transport: custom(sim.provider) });
const test = createTestClient({ chain, mode: 'anvil', transport: custom(sim.provider) });     // viem's test actions work unchanged: setBalance, mine, snapshot…
```

Everything the Worker does, without a page: unit-test your frontend math against the real contracts, or drive a
scenario through `runScenario` from `@terrariumlabs/core/worker` (the unit suite does both). No network, no Foundry, no browser.

## 20. The wallet vs the node view

```js
sim.provider   // the wallet: eth_accounts lists the ten accounts, eth_sendTransaction signs, cheatcodes and terrarium_* work
sim.node       // the same chain as a read-only node: eth_accounts is [], wallet methods throw 4100
```

Hand `sim.node` to code that must behave as if it were talking to a public RPC (an indexer, a read client), and
`sim.provider` to the wallet side.

## 21. Randomness that replays

```ts
seed: 1337,                                   // defineScenario / createTerrarium
const r = ctx.random();                       // mulberry32 from the seed: the same actors make the same trades on every boot
```

Seeded scenarios give reproducible demos and deterministic e2e runs. Omit the seed for a fresh one per boot.

## 22. Proving a block is real

```js
const block = await pub.getBlock({ blockTag: 'latest', includeTransactions: true });
// header hash = keccak of the RLP header; transactionsRoot = trie of the block's txs; receiptsRoot = trie of EIP-2718 receipts;
// logsBloom = OR of the receipts' blooms; stateRoot = the Merkle trie root (merkle mode). test/uniswap-v2.mjs recomputes all of them
```

Blocks are sealed for real, so a client that verifies what it is told (a light client, a checker script) is satisfied.
`npm run test:uniswap` runs the same scenario here and on Anvil and compares byte for byte.

## 23. React without the Vite plugin

```tsx
// terrarium.worker.ts:  import scenario from './terrarium.scenario'; import { runScenario } from '@terrariumlabs/core/worker'; runScenario(scenario);
import { Terrarium, useTerrarium, DevBar } from '@terrariumlabs/react';
{import.meta.env.DEV && <Terrarium worker={() => new Worker(new URL('./terrarium.worker.ts', import.meta.url), { type: 'module' })} />}
const provider = useTerrarium();                         // in a child: the wallet provider for your own dev tools (null until ready)
<DevBar provider={provider} />                           // only the bar, over any provider answering terrarium_* methods
```

For Next.js, Remix, CRA and Storybook. Guard it with your bundler's development constant so production drops it, and check
the bundle once. Prefer the Vite plugin when you can: it keeps the simulator out of your source entirely.
[integrations.md](integrations.md) has the Next.js and Storybook recipes and the script-tag path for everything else.

On Vite, a React app that wants the component (context, StrictMode, unmount) without writing the two files or the guard
lets the plugin generate them: `terrarium({ mount: 'react' })`, then

```tsx
import TerrariumMount from 'virtual:terrarium/react';            // the generated <Terrarium> over the generated Worker, or null when off
root.render(<>{TerrariumMount && <TerrariumMount />}<App /></>);
```

Off (`VITE_TERRARIUM=off`), the module exports `null` and the bundle carries none of the simulator: the gating is the
plugin's, not a constant you maintain.

## 24. The transaction explorer

The dev bar's **Transactions** button opens a panel listing every transaction on the chain, newest first, like a block
explorer: status, block, time, hash, method, from, to, value, gas, events. A row expands to the receipt, the decoded call and
its arguments, the raw input, the revert reason and every event.

Decoding tries an address's own ABI first (from `ctx.label` or the fixture that installed it), then the scenario's `abis`, then a built-in
set, so two ABIs sharing a selector never fight. Standard things decode with no configuration: ERC-20/721/1155/4626 transfers, approvals, deposits and withdrawals, WETH,
Uniswap V2 `Swap`/`Sync`/`Mint`/`Burn`, Ownable, proxies, OpenZeppelin's custom errors, `Error(string)` and `Panic`. Contracts
installed from a fixture are named by their fixture keys. Contracts imported from an Anvil deployment with `--broadcast` and `--artifacts` (recipe 3) arrive named and with their ABIs.
For the rest, name an address where you learn it, with its ABI:

```ts
export default defineScenario({
  abis: [routerAbi, PEPE.abi],                                   // protocol-specific calls and custom errors
  labels: { [ROUTER]: 'Uniswap V2 Router', [TOKEN]: 'PEPE' },   // addresses known up front
  async setup(ctx) {
    const pair = await ctx.pub.readContract({ address: factory, abi: factoryAbi, functionName: 'getPair', args: [TOKEN, weth] });
    ctx.label(pair, 'PEPE/WETH pair', pairAbi);                 // discovered here: name + ABI in one line
    ctx.label(ctx.accounts[0], 'You');
  },
});
```

The same data from a test or the console, no ABIs needed for the raw form:

```ts
const { total, transactions } = await sim.provider.request({ method: 'terrarium_transactions', params: [{ limit: 20 }] });
transactions[0];   // { hash, from, to, value, input, status: 'reverted', receipt, timestamp, error, revertData, method: { name, args }, revert: { name, args }, logs: [{ ..., decoded: { name, args } }] }
```

In a React dev tool of your own (`@terrariumlabs/react`): `const txs = useTransactions({ limit: 20 })`, the same shape, polled.

The panel has a text filter (hash, address, label, method or event name), the all / mine / failed selector, a taller mode, and a
click on a hash copies it. `Alt+Shift+X` toggles it, `Esc` closes it.

**Hide** collapses the bar to a leaf at the bottom right (remembered across reloads); the chain keeps running. `Alt+Shift+T` does the same. To start that
way: `terrarium({ devBar: 'hidden' })` in the Vite plugin, `startTerrarium(worker, { devBar: 'hidden' })`, `<Terrarium devBar="hidden">`,
or `npx terrarium build --devbar hidden`. A Hide/Show click always wins over the default.

## 25. wagmi: reads on the Terrarium chain

A viem dapp reads through the wallet provider it discovered; a wagmi dapp declares one transport per chain up front, before
any wallet is connected, and `http()` has nothing to point at (the wallet is the node). `@terrariumlabs/core/transport` is that
transport: `custom()` over the EIP-6963 announcement, found on the first request.

```ts
import { terrariumTransport } from '@terrariumlabs/core/transport';      // no engine code, a few dozen lines
const terrarium = defineChain({ id: 31337, name: 'Terrarium', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
createConfig({ chains: [mainnet, terrarium], transports: { [mainnet.id]: http(), [terrarium.id]: terrariumTransport() } });
```

Keep it behind the same guard as the mount: a page without a Terrarium has nothing to find, and reads on that chain fail
the way reads on an unreachable RPC would. The wallet side needs nothing: wagmi's `injected()` discovery lists "Terrarium
Wallet" like any extension.

## 26. Several scenarios

One file, a list: the dev bar grows a selector, each scenario keeps its own chain, the choice survives reloads. Start from a
base and change one thing per variant:

```ts
const fresh = defineScenario({ name: 'Frogpond', description: 'The pond as it opens', persist: 'frogpond', async setup(ctx) { /* … */ } });
const afterTheDump = defineScenario({
  ...fresh, name: 'After a whale dump', description: 'Someone sold 40M PEPE into the pool: a crashed price, a cliff on the chart',
  async setup(ctx) { await fresh.setup!(ctx); if (ctx.fresh) await sellAsWhale(ctx, parseEther('40000000')); },
});
const indexerDown = defineScenario({ ...fresh, name: 'Indexer down', description: 'The subgraph answers 503 from the first request', async setup(ctx) { await fresh.setup!(ctx); ctx.state.indexer = 'down'; } });
export default defineScenarios([fresh, afterTheDump, indexerDown]);
```

A listed scenario persists under the slug of its name (`after-a-whale-dump`) unless it sets `persist`; **Reset** wipes only the
active one. From a test: `terrarium_scenarios` lists them, `terrarium_selectScenario('Indexer down')` stores the choice and asks
the page to reload; `terrarium_status().scenario` says which one is running.
