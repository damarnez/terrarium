# In-browser EVM simulator for frontend testing — investigation & design

*Investigation date: 2 Sep 2026. Companion code: `evmsim-poc/` (runnable proof of concept, measured numbers below come from it).*

---

## 0. Verdict in one page

**The idea is sound and buildable in weeks, with one correction: do not transpile Solidity to WASM.**
Compile Solidity exactly as today (solc / Foundry / Hardhat) and run the resulting **EVM bytecode** inside an
**EVM that lives in the browser**. The artifact you ship to the frontend is the standard build artifact
(`abi`, `bytecode`, `deployedBytecode`, `storageLayout`). Everything you listed maps cleanly onto that:

| You asked for | How it is delivered |
|---|---|
| "respond like a regular contract interaction" | Real EVM execution → byte-identical return data, revert data (custom errors), events, gas, addresses |
| "create block numbers … respond like a regular transaction" | Local chain model: mempool → blocks (auto / manual / interval / follow), receipts, logs, filters, snapshots |
| "front can subscribe to mock responses from other places" | *Actors*: scripts that react to on-chain events (and time/blocks) by sending transactions as other parties |
| "external contracts … via RPC or mock them" | **Fork mode**: lazily pull any live contract's code+storage and execute it locally. **Mock mode**: a JS handler at an address (behaves like a precompile). Mix per address. |
| "follow the block numbers from the connected chain" | `follow` mining mode: mirror the live chain's `newHeads` (number + timestamp) into local blocks |
| "very easy to integrate" | The simulator *is a wallet* (EIP-1193 provider announced via EIP-6963). Your dapp's existing connect modal shows "Sim Wallet"; wagmi/viem/ethers/RainbowKit/AppKit need **zero code changes**. |
| "only build the artifact and move it to the front" | Build plugin reads Foundry `out/` → emits one typed TS module + a `sim.config.ts` (deploy plan, forks, mocks, actors) |
| "small" | PoC browser bundle: **548 KB min / 166 KB gzip / 135 KB brotli** including viem utils (137 KB gzip without). Dev-only chunk, never in production. |

**Engine choice (Sept 2026):** `@ethereumjs/*` v10 — TypeScript, browser-first, controlled dependency set,
tracks hardforks up to Amsterdam. It is what the PoC uses: boots in **~60 ms** in Chromium, **~6 ms per write**
through the full viem path, **0.5 ms per read**. WASM EVMs (Guillotine/Zig ≈110 KB claimed, revm→wasm) are
attractive but not production-ready for this use; design the engine behind a small interface and swap later.

**Closest existing project:** [Tevm](https://github.com/evmts/tevm) — same idea, already ships fork + mining +
viem/Anvil actions + `import './X.sol'`. Evaluate it first. Caveats found during this investigation: still
prerelease, and *both* current published channels fail to import on a fresh install today (inter-package
version drift: `1.0.0-rc.153` and `2.0.0-next.107`); working bundle is **1.75 MB min / 449 KB gzip** (3× the
PoC, mostly `zod` + all viem chains); the engine is being rewritten (Guillotine). Two viable paths:
**(A)** pin/patch Tevm and contribute, or **(B)** own a thin ~1.5–2k-LOC layer directly on ethereumjs (what the
PoC does). Recommendation below: **(B)**, borrowing from Tevm (MIT) where useful.

---

## 1. Reframing: "transpile to WASM" vs "run the EVM in the browser"

| | Transpile Solidity → WASM (Solang/SOLL-style) | Compile to EVM bytecode, run an EVM in the browser |
|---|---|---|
| Fidelity to production | Different runtime model: ABI encoding, `msg.sender`/`delegatecall`/proxies, `CREATE2` addresses, gas, precompiles, revert data all differ or need re-implementation | **Identical** — it is the same bytecode the chain runs |
| External / third-party contracts | Impossible unless you also have their source and port them | Fetch code+storage from any RPC and execute locally (fork) |
| Toolchain | New compiler in the loop; solc's own EWasm backend was **removed in 0.8.21 (July 2023)** — the ecosystem abandoned this path | Your existing `forge build` / `hardhat compile` output |
| Debuggability | New source maps, new tooling | Existing source maps, `storageLayout`, ABI decoders, Foundry traces work |
| What is WASM | Your contracts | The **interpreter** (optional; JS is fast enough today) |

Conclusion: keep Solidity → EVM bytecode; put the effort into the runtime + integration layer. "WASM" remains a
valid *implementation detail* of the interpreter (see §2), not of the artifact.

---

## 2. Landscape (what exists, Sept 2026)

### 2.1 EVM engines that run in a browser

| Engine | Language / form | Browser status | Size (measured or claimed) | Fork (lazy remote state) | JS-scripted mocks | Notes |
|---|---|---|---|---|---|---|
| **@ethereumjs/evm + vm** (v10.1) | TypeScript | ✅ Full stack browser-ready since v10 (Pectra), no restrictions | PoC bundle 548 KB / 166 KB gz (with viem utils) | ✅ `RPCStateManager` (async state, uses `eth_getProof`/`eth_getCode`/`eth_getStorageAt`) | ✅ `customPrecompiles` / `evm.precompiles` map | Used by Remix VM, Tevm; Amsterdam HF already supported |
| **Tevm** (1.0.0-rc / 2.0.0-next) | TypeScript on ethereumjs forks | ✅ (when the install resolves) | 1.75 MB / 449 KB gz (full client, measured) | ✅ `fork.transport` | ✅ custom precompiles, `tevmSetAccount` | Vite/esbuild/Bun plugins to `import './X.sol'`; Anvil-compatible RPC; sync-storage persister |
| **Guillotine** (Zig) | Zig → WASM | 🚧 alpha; "will replace the JS EVM in Tevm once stable" | ~110 KB wasm claimed (4× smaller than alternatives) | ❓ sync host interface → needs prefetch/JSPI for lazy fork | via host hooks | Fast interpreter; `guillotine-mini` is the core |
| **revm** (Rust) | `no_std`, wasm-capable | Possible; Tevm's `@tevm/revm` binding abandoned (2023–24) | ~300–600 KB wasm typical for Rust+crypto (estimate) | sync `Database` trait → same async problem | `Inspector::call` override (how Foundry does `vm.mockCall`) | Foundry/Anvil engine |
| **evmone** (C++) | Emscripten possible | No maintained browser package known | — | — | — | Fastest interpreter; would need bespoke bindings |

The **async-state problem** is the key technical reason JS/TS wins today for *fork mode*: a WASM interpreter is
synchronous, but remote state arrives asynchronously. Options are (a) prefetch via `eth_createAccessList` then
run, retry on miss; (b) Asyncify (slow, bigger); (c) **JSPI** — standardized (Wasm CG Phase 4, April 2025),
shipping in Chrome 137+ and Firefox, **not in Safari** as of early 2026. ethereumjs' state manager is natively
async, so none of this is needed.

### 2.2 Wallet & mocking tooling (reuse, don't rebuild)

- **EIP-6963** (Multi Injected Provider Discovery): wagmi v2 `injected()` discovers announced providers by
  default; RainbowKit/AppKit/ConnectKit too. Announcing the simulator as a wallet = zero-touch integration.
- **`@johanneskares/wallet-mock`**: headless EIP-6963 wallet for Playwright that signs with a viem local account
  and forwards to a real node — validates the "sim as wallet" pattern (we replace the node with the in-page EVM).
- **wagmi `mock` connector**: `mock({ accounts })` sends `eth_sendTransaction` through the configured transport
  → works with our provider because it accepts unsigned txs for known/impersonated accounts (Anvil semantics).
- **viem `createTestClient({ mode: 'anvil' })`**: `mine`, `increaseTime`, `setBalance`, `impersonateAccount`,
  `snapshot`, `revert`, `setStorageAt`, … — we implement the Anvil/Hardhat method names so this works unchanged
  (verified in the PoC).
- **Synpress / MetaMask automation**: heavy; only needed for wallet-UI-specific tests, not contract flows.
- **MSW-style JSON-RPC mocking** (`@depay/web3-mock`, hand-written responses): tiny but hand-maintained
  return values drift from real contract behavior — the exact problem this project removes.

### 2.3 The status quo it replaces

Anvil/Hardhat node as a separate process + a dev wallet or `wallet-mock` + fixtures. Works, but: process
lifecycle in CI/Storybook/StackBlitz, no in-page scenario scripting, wallet plumbing, flaky ports. The
in-browser simulator makes tests/stories **self-contained**: `import` it, run.

---

## 3. Architecture

```
 build time                                  dev / test runtime (browser, Node, Playwright, Storybook)
 ─────────────                               ───────────────────────────────────────────────────────────
 forge build ──► out/*.json ──► evmsim ──►  sim.artifacts.ts  (abi as const, bytecode, storageLayout, typed)
                                build        sim.config.ts     (chain, accounts, forks, mocks, deploy plan, actors)
                                                     │
                                                     ▼
            ┌────────────────────────────────────────────────────────────────────────────┐
            │  Scenario layer   mocks (JS handlers @ address) · actors (react to logs/    │
            │                   blocks/time) · fork policy · follow-chain · fixtures      │
            ├────────────────────────────────────────────────────────────────────────────┤
            │  RPC layer        eth_* · wallet_* · personal_/eth_signTypedData ·          │
            │                   anvil_/hardhat_/evm_* cheatcodes · filters · subscriptions│
            ├────────────────────────────────────────────────────────────────────────────┤
            │  Chain layer      mempool → blocks (auto|manual|interval|follow) · receipts │
            │                   · logs/bloom · snapshots · time control · single queue    │
            ├────────────────────────────────────────────────────────────────────────────┤
            │  Engine           EVM + state (ethereumjs today; WASM engine behind the     │
            │  interface        same interface later) · fork state manager + cache        │
            └────────────────────────────────────────────────────────────────────────────┘
                     │ EIP-1193 provider (request/on)                     │ optional
        ┌────────────┼───────────────────────────────┐          ┌─────────┴─────────┐
        ▼            ▼                               ▼          ▼                   ▼
  EIP-6963      viem custom()                 fetch/WS intercept   Web/SharedWorker   Vitest / Node
  "Sim Wallet"  transport swap (env flag)     of the app's RPC URL  (off main thread,   (same code)
  zero changes  programmatic tests            (read path)           multi-tab = multi-user)
```

Everything runs on one machine, in one process; the only network traffic is optional fork fetches and
following the live chain.

---

## 4. Component design

### 4.1 Artifact & build step

**Input:** Foundry `out/<Contract>.sol/<Contract>.json` (or Hardhat artifacts). Nothing new to compile.

**Output (`evmsim build`, also as a Vite/esbuild plugin):**

```ts
// sim.artifacts.ts — generated
export const Vault = {
  abi: [...] as const,                 // `as const` → viem/wagmi infer types end to end
  bytecode: '0x…',
  deployedBytecode: '0x…',
  storageLayout: {...},                // lets the sim "deal" ERC20 balances by writing the right slot
} as const;
```

```ts
// sim.config.ts — hand-written, tiny
import { defineSim } from 'evmsim';
import { Vault, MockOracle } from './sim.artifacts';

export default defineSim({
  chain: { id: 8453, name: 'Base' },                 // impersonate the real chain id → app config untouched
  accounts: 'anvil',                                   // the 10 well-known test keys, funded
  fork: { url: import.meta.env.VITE_FORK_RPC, block: 'latest-5', cache: 'indexeddb' }, // optional
  mining: { mode: 'auto' },                            // 'manual' | { interval: 2000 } | 'follow'
  external: {
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913': 'fork',            // real USDC on Base
    '0xOracle…': { mock: { latestPrice: () => 2000n * 10n ** 18n } }, // JS handler
  },
  async setup(sim) {                                   // deploy plan, runs once per boot (or replays broadcast/*.json)
    const oracle = await sim.deploy(MockOracle);
    const vault  = await sim.deploy(Vault, [oracle.address]);
    await sim.deal('0x8335…2913', sim.accounts[0], 1_000_000n); // ERC20 balance via storageLayout
    return { vault, oracle };
  },
  actors: [
    { on: { contract: 'vault', event: 'Deposited' }, do: async (log, ctx) => ctx.as('keeper').write(...) },
    { everyBlocks: 10, do: (ctx) => ctx.as('oracleUpdater').write(...) },
  ],
});
```

Deployment options, in order of preference: (1) TS `setup()` as above; (2) replay Foundry
`broadcast/*/run-latest.json` so the *same* deploy script produces the *same* addresses; (3) later: a
cheatcode precompile (`0x7109…12D`) implementing `prank/deal/warp/roll/etch/store/load/mockCall` so
`forge script` fixtures run inside the browser unchanged.

### 4.2 Engine interface

Keep the interpreter swappable — the only part of the stack likely to change (JS → WASM):

```ts
interface Engine {
  call(msg: CallMsg, ctx: BlockCtx): Promise<CallResult>;              // eth_call / estimateGas
  runTx(tx: TypedTx, ctx: BlockCtx): Promise<TxResult>;                 // receipts, logs, gas, createdAddress
  state: { getAccount; putAccount; getCode; putCode; getStorage; putStorage; checkpoint; commit; revert };
  hooks: { onCall(address, handler): void };                            // JS mocks (precompile-style)
}
```

ethereumjs implementation ≈ 150 lines (see `src/sim.mjs`). Custom precompiles give the `onCall` hook for free.

### 4.3 Chain layer

- **Mining modes:** `auto` (block per tx — default, what Anvil does), `manual` (`evm_mine`), `interval` (test
  pending states / optimistic UI), `follow` (§4.7).
- **Block header:** real `Block` header object → real 32-byte hash; `baseFeePerGas` constant (or copied from the
  followed chain); `timestamp = max(parent+1, now+offset)`; `evm_setNextBlockTimestamp`, `evm_increaseTime`.
- **Receipts/logs:** exact geth JSON shapes (`status`, `gasUsed`, `cumulativeGasUsed`, `effectiveGasPrice`,
  `contractAddress`, `logs[]` with `logIndex/blockHash/…`, `logsBloom`). Verified: viem decodes them unmodified.
- **Filters:** `eth_newFilter / eth_newBlockFilter / eth_getFilterChanges / eth_getFilterLogs / eth_uninstallFilter`
  — this is what `watchContractEvent`/`useWatchContractEvent` use. **Bug found in the PoC:** a cursor beyond
  `latest` must resolve to a number, not fall back to genesis (or every poll re-delivers all logs).
- **Subscriptions:** `eth_subscribe(newHeads|logs)` delivered via the EIP-1193 `message` event for libraries
  that prefer push.
- **Snapshots:** `evm_snapshot / evm_revert` = state checkpoint + chain truncation. Test isolation per story/test.
- **Historical state:** `eth_call` at an old block needs per-block state snapshots (or replay). v1: latest only;
  document; add "keep last N block states" later.
- **Single execution queue.** Every state-touching request runs through one async mutex. **Real bug hit in the
  PoC:** an actor's `estimateGas` (checkpoint/revert) interleaved with the test's `evm_revert` and corrupted the
  state stack. Anvil serializes for the same reason.
- **Persistence:** serialize state diff + blocks to IndexedDB (`localStorage` for small); reload keeps the
  chain; export/import as JSON fixtures for CI.

### 4.4 Fork mode (external contracts via RPC)

- `RPCStateManager` pins a block and lazily fetches `eth_getProof` (account fields), `eth_getCode`,
  `eth_getStorageAt` on first touch; everything written locally stays local. Verified: read mainnet USDC through
  the local EVM, impersonated an exchange wallet, transferred with the **real** USDC bytecode, got a real
  `Transfer` log — 2.2 s end-to-end including network.
- **Cache** fetched slots in IndexedDB keyed by `(chainId, block, address, slot)`; export the cache as a
  fixture → deterministic, offline CI runs.
- **Pin, don't chase:** state stays at the fork block while block numbers/timestamps may advance (follow mode);
  expose `refork()` to re-anchor.
- **Prefetch hint:** for a known flow, `eth_createAccessList` on the remote RPC returns all slots the tx will
  touch → one round trip instead of dozens.
- **Chain id impersonation:** report the *real* chain id (1, 8453, …) so the app's chain config, addresses and
  explorer links are exercised exactly as in production.
- **Browser constraints:** the RPC must allow CORS (public endpoints like publicnode do; many paid endpoints
  need a key/proxy); full nodes serve `eth_getProof` only for recent blocks (~128) — fork a few blocks behind
  `latest`, or fall back to `eth_getBalance/eth_getTransactionCount/eth_getCode` when proof is unavailable.

### 4.5 External contract mocking (three levels, mix per address)

1. **Solidity mocks** compiled into the artifact — most faithful, zero new concepts.
2. **JS handlers at an address** (PoC `sim.mockContract(addr, abi, { fn: (...args) => result })`) — decoded args
   in, decoded result out (or `throw` → `Error(string)` revert; return custom error via `revertWith`). Emits
   logs if the handler returns `{ result, logs }`. A `0x00` code byte is written so Solidity's `extcodesize`
   check passes. Ideal for oracles, bridges, price feeds, "whatever the backend returns".
3. **Fork + override** — real bytecode with surgical `setStorageAt`/`setCode`/per-selector `mockCall`
   (Foundry's `vm.mockCall` shape): e.g. real Uniswap pool, mocked Chainlink answer.

### 4.6 Actors & scenarios ("mock responses from other places")

```ts
sim.onLog({ address: vault, event: 'Deposited' }, async (log, ctx) => {
  await ctx.after({ blocks: 2 });                                   // realistic latency
  await ctx.as(keeper).write(vault, 'settle', [log.args.user]);    // another party responds
});
sim.every({ seconds: 60 }, (ctx) => ctx.as(oracleUpdater).write(feed, 'update', [nextPrice()]));
sim.wallet.script({ onSendTransaction: 'reject' /* 4001 */ | 'delay:3000' | 'prompt' });
sim.rpc.script({ 'eth_getLogs': 'rate-limit', 'eth_call': { latencyMs: 800 } });                     // resilience UI
```

Actors run *after* a block is final (no re-entrancy), through the same queue, as impersonated accounts —
no keys needed for "other users". Multi-tab: run the chain in a **SharedWorker** so two tabs = two users.

### 4.7 Following the connected chain

`follow` mode subscribes to the live chain (`eth_subscribe newHeads` over WS, or polling) and, per remote block,
mines one local block with the **same number and timestamp**; pending local txs ride in it. Verified in the PoC:
local head tracked mainnet 25888676 → 25888678 at the real 12 s cadence. Variants: `hybrid` (automine but
stamp real timestamps), `offset` (stay N blocks behind). Fork state stays pinned unless `refork()`.

### 4.8 Wallet surface

`eth_accounts / eth_requestAccounts`, `eth_sendTransaction` (signs with test keys or impersonates),
`eth_sendRawTransaction`, `personal_sign`, `eth_signTypedData_v4` (SIWE, permits — verified), `wallet_switchEthereumChain`
(4902 when unknown), `wallet_addEthereumChain`, `wallet_(get|request|revoke)Permissions`, `accountsChanged` /
`chainChanged` / `connect` / `disconnect` events, scripted rejections (4001) — and, worth adding in 2026,
**EIP-5792 `wallet_getCapabilities` / `wallet_sendCalls` / `wallet_getCallsStatus`** for batch flows.

### 4.9 Integration modes

| Mode | Code change in the app | Use |
|---|---|---|
| **EIP-6963 announce** (`sim.announce()` in a dev-only entry) | none — pick "Sim Wallet" in your own modal | manual QA, demos, Storybook |
| **viem `custom(sim.provider)` transport** behind `import.meta.env.DEV` | 1 line in wagmi config | programmatic tests, deterministic reads |
| **fetch / WebSocket interception** of the app's RPC URL | none | apps that read via their own `http()` RPC rather than the wallet |
| **Playwright `page.addInitScript`** | none | e2e: inject sim + fixtures before the app loads |
| **Vitest / Node** | import the same module | unit tests of hooks/services against real bytecode |
| **Web/SharedWorker** | none | off-main-thread execution; multi-tab multi-user |

Dev-only bundling: `if (import.meta.env.DEV) await import('evmsim/browser')` → tree-shaken out of production;
CI asserts the production bundle contains no simulator code or test keys.

---

## 4b. State: where it lives, how it survives a reload, how to fabricate it

*(Added after the follow-up question "does the WASM keep contract state? can we use localStorage? how do we add fake liquidity?")*

### 4b.1 What holds the state

The state is **not in the artifact**. The artifact is code (bytecode + ABI); the *state* — every storage slot,
balance, nonce and the block/receipt history — lives in the simulator's state manager, in memory. In a fresh
tab it starts empty (or at the fork's remote state). So yes: while the page lives, "create a vault, add
liquidity, read it back" behaves exactly like a chain. Across a reload, you need one of the two mechanisms below.

### 4b.2 Persistence: two complementary mechanisms (both implemented in the PoC)

| | **State dump** (`sim.dumpState()` / `persist:`) | **Journal replay** (`sim.journal` / `replayJournal()`) |
|---|---|---|
| What is stored | The *diff*: every locally written account / code / storage slot + blocks, receipts, logs, cheat state (+ for forks: every remote read, see 4b.4) | The list of state-changing RPC calls (`eth_sendTransaction`, cheatcodes, `sim_deal`, `sim_setState`) + the block timestamps |
| Restore | exact, fast (~10 ms) | re-executes everything (~8 ms per tx), reproduces **identical block hashes** (verified) |
| Survives recompiling your contracts | ❌ old bytecode/state comes back | ✅ replays the same user actions onto the new bytecode |
| Best for | reload while developing, Storybook stories, e2e fixtures | "scenario files" committed to the repo; migrating scenarios when contracts change |

The write log makes the dump small: the vault-with-liquidity scenario (6 blocks, 3 contracts, 8 journal
entries) is **57 KB of JSON**. The PoC persists automatically (debounced) after every block or cheat, to
anything with `getItem/setItem`:

```ts
// browser: localStorage — 5 MB quota, fine for typical dev scenarios (57 KB here)
const sim = await createSim({ persist: { storage: localStorage, key: 'evmsim:vault-scenario' } });
// bigger scenarios / fork caches: IndexedDB adapter (async getItem/setItem, hundreds of MB)
const sim = await createSim({ persist: { storage: idbStorage('evmsim'), key: 'vault-scenario' } });
// CI / tests: a committed JSON fixture
const sim = await createSim({ restore: JSON.parse(readFileSync('fixtures/vault-scenario.json')) });
```

**Verified in Chromium:** first load builds the scenario in 325 ms and writes 56.5 KB to `localStorage`;
reload #1 restores in 143 ms and continues at block 6 with the old deposit receipt still served; reload #2 → block 7.

What is *not* persisted: JS functions (mock handlers, actors). They belong in `sim.config.ts` and re-attach
on boot; the state they produced is in the dump. Filters/subscriptions are per page life, as on a real node.

### 4b.3 Fabricating state ("fake liquidity"): the toolbox, from safest to sharpest

**The governing rule: change the *EVM state*, never the *RPC responses*.** If you intercept `eth_call` and
rewrite the answer to `balanceOf`, the Vault contract that itself calls `token.balanceOf(vault)` during
`deposit()` will not see your fake number — internal calls are SLOADs, not RPC. Response-rewriting only fakes
direct reads and breaks composability. Every tool below writes real state, so *everything* (your contracts,
the frontend, third-party bytecode) agrees.

| Tool | What it does | Consistency | Use for |
|---|---|---|---|
| **Real transactions with cheats** — impersonate a whale/owner (`anvil_impersonateAccount`), fund it (`anvil_setBalance`), call the real `transfer/mint/addLiquidity` | Structural state is produced by the contracts themselves | ✅ always | LP positions, Uniswap V3 NFTs, vault shares, anything with derived state |
| **`sim.deal(token, user, amount)`** — Foundry-style: finds the ERC20's balance slot and writes it (adjusts `totalSupply` too) | Slot discovery by **recording the SLOADs of `balanceOf(user)`**, then confirming with a sentinel write — works through proxies (storage context = proxy), Solidity or Vyper layouts, ERC-7201 namespaced storage | ✅ leaf state | giving the user tokens on any token, forked or local. **Verified on real mainnet USDC** (a proxy): 5,000 USDC dealt, then moved with the real `transfer()` |
| **`sim.setState(address, storageLayout, { balances: { [alice]: 10n**18n }, totalShares: … })`** — by variable name, using the artifact's `storageLayout` (mappings, nested mappings, dynamic arrays, value types) | You choose the values; the PoC also exposes `slotFromLayout()` | ⚠️ you keep invariants (e.g. also `deal` assets to the vault when you mint shares) | your own contracts, without writing a mint/admin path |
| **`anvil_setStorageAt` / `anvil_setCode` / `anvil_setBalance`** | raw slot / code / ETH | ⚠️ raw | anything else; swapping an implementation |
| **`eth_call` state overrides** (`stateOverride` param, geth format; viem passes it) | fake state *for one read only*, nothing persists | ✅ side-effect free | "what would the UI show if the user had 42 tokens" — verified: `42` with override, `0` without |

Where the "fake liquidity" should go depends on the state's shape:

- **Leaf state** (balances, allowances, oracle answers, flags): write it — `deal` / `setState`.
- **Structural state** (pool reserves + LP `totalSupply`, V3 ticks/positions, vault shares + assets): produce it
  with **real transactions** after dealing the inputs. Writing it raw creates inconsistent state the UI will
  eventually trip over (e.g. shares without assets → `totalAssets()` division surprises).
- **Third-party state you can't rebuild** (a Uniswap pool, Aave market): **fork it** and then deal/impersonate.

Tokens whose `balanceOf` is *computed* (rebasing stETH, Aave aTokens' scaled balances, ERC-4626 wrappers)
fail slot discovery on purpose (`deal` throws with a hint): use impersonation or the underlying token.

### 4b.4 "Wrap the calls to the RPC": yes — but the *upstream* RPC, and for three reasons

There are two RPC boundaries. **Downstream** (frontend → sim) is where state overrides for reads live
(`stateOverride`), nothing else should be rewritten there (see the rule above). **Upstream** (sim → fork
provider) is worth wrapping — the PoC's `RecordingRPCStateManager` does it — for:

1. **Recording** every remote read → the dump becomes a **fork fixture**: `remote.accounts/code/storage`.
   Verified: a forked-mainnet USDC session (60 KB fixture) restored with a *bogus* RPC URL — reads and a new
   real `transfer()` succeed with zero network.
2. **Retries with backoff** — public RPCs hiccup and rate-limit; a failed `eth_getProof` must not fail a tx.
3. **Overrides at fetch time** (planned): `forkOverrides: { [token]: { [slot]: value } }` for state you want
   different from the chain *before* the first read — equivalent to writing after fork, but lazy.

### 4b.5 Bugs this exercise caught (all fixed in the PoC, two are upstream)

- **ethereumjs `RPCStateManager.commit()` only commits the *account* cache** (statemanager 10.1.3), leaving
  the code/storage caches one checkpoint deep. Symptom: after any `runTx`, a `revert()` restores the wrong
  level — an `eth_call`'s SSTOREs leaked into fork state. Fix: subclass, `commit() { this._caches.commit() }`.
  Worth an upstream issue.
- **`originalStorageCache` is not cleared by bare `runCall`** (only by `runTx`). Stale "original" values make
  SSTORE metering wrong in `eth_call`/`estimateGas` → underestimates → out-of-gas reverts in real txs (the
  USDC proxy needed 45.1k, the estimate said 45.0k). Fix: clear it before every read-only execution.
- **Heuristic gas estimation is not good enough for proxies** (63/64 rule on the delegatecall). Replaced with
  the geth/anvil algorithm: one full simulated tx, optimistic `(used + refund) · 64/63` probe, binary search to
  1.5 %. Cost: ~2 ms per write (8.1 ms vs 5.9 ms per `writeContract`).
- `sim.deal`/`setState`/`sendAs` bypassed the journal → replay diverged. Everything that changes state now
  goes through the RPC layer so it is recorded (design rule: **one entry point for mutations**).

---

## 5. Measurements from this investigation

### 5.1 Bundle size (esbuild, minify, browser target)

| Bundle | raw | gzip | brotli | Notes |
|---|---|---|---|---|
| **PoC simulator** (ethereumjs vm/evm/state/tx/block/common/util + viem utils) | 548 KB | **166 KB** | 135 KB | `@ethereumjs/evm` 152 KB, `@noble/curves` 80 KB, viem 85 KB, tx 34 KB, statemanager 24 KB |
| PoC simulator **+ persistence, deal/setState, state overrides, fork recording, real gas estimation** | 572 KB | **173 KB** | 141 KB | the whole state chapter (§4b) costs 7 KB gzip |
| PoC simulator, viem external (the app already has viem) | 462 KB | **137 KB** | 114 KB | incremental cost for a wagmi/viem app |
| Tevm `createMemoryClient` (1.0.0-next.149, pinned to make it load) | 1,753 KB | 449 KB | 344 KB | `zod` 425 KB, viem 374 KB (all chains), `@ethereumjs/trie` 83 KB, `@tevm/contract` 92 KB |
| Tevm tree-shakable `createTevmTransport` | 1,733 KB | 443 KB | 340 KB | tree-shaking barely helps today |
| Guillotine (Zig → WASM), claimed | ~110 KB wasm | — | — | alpha; would replace the 152 KB EVM core, not the chain/RPC layer |

Reading: the *chain + RPC + wallet* layer is ~15 KB; the interpreter and crypto dominate. A WASM interpreter
could cut the total roughly in half; it does not change the integration design. For a **dev-only** chunk,
137–166 KB gzip is already unobtrusive (comparable to one UI library).

### 5.2 Performance (Node 22 / Chromium 151, same code)

| Operation | Result |
|---|---|
| Boot (create VM, fund 3 accounts, genesis) | 54 ms (Node) · 61 ms (Chromium) |
| `writeContract` end-to-end via viem (estimateGas + send + block + receipt + logs), automine | **5.9 ms / tx** (heuristic gas) · **8.1 ms / tx** (geth-style binary-search gas) |
| Restore a persisted scenario (6 blocks, 3 contracts) from `localStorage`, in Chromium | 143 ms incl. boot |
| Replay the 8-entry journal onto a fresh chain | < 100 ms, identical block hashes |
| Restore a forked-mainnet session from a 60 KB fixture, offline | 10 ms |
| 1,000 txs mined into one block | 3.2 ms / tx |
| `readContract` (`eth_call`) | **0.47 ms** |
| `eth_getLogs` over 202 blocks | 16 ms |
| Deploy + deposit + event watcher, in the browser, discovered via EIP-6963 | 281 ms total |
| Fork mainnet: 3 reads of real USDC + impersonated transfer + receipt | 2.2 s (network-bound) |

### 5.3 Fidelity checks that passed (viem unmodified)

Deploy → familiar Anvil address `0x5FbDB…0aa3` (same nonce/derivation) · receipts/logs decoded · custom error
`InsufficientBalance(5,1)` decoded from revert data · `createTestClient({mode:'anvil'})` `mine/increaseTime/snapshot/revert`
· `watchContractEvent` via filters (exactly 2 events, no duplicates after the cursor fix) · `personal_sign` ·
`getBlock` with baseFee/hash · real USDC bytecode executed on forked state · `deal` on real USDC through its
proxy · `readContract({ stateOverride })` · `localStorage` persistence across two page reloads · journal replay
with identical block hashes · offline fork fixture.

### 5.4 Tevm install/bundle findings (Sept 2, 2026)

- `npm i tevm` (latest = `1.0.0-next.149`) → resolves `@tevm/actions@1.0.0-rc.153` + `@tevm/errors@1.0.0-rc.151`
  → **`SyntaxError: does not provide an export named 'NoSignerAvailableError'`** on import.
- `npm i tevm@rc` (`1.0.0-rc.153`) → same error (errors package not published at rc.153).
- `npm i tevm@2.0.0-next.107` (modified 2026-07-30) → **`@ethereumjs/util does not provide 'isHexPrefixed'`**.
- Loadable only after pinning all 38 `@tevm/*` sub-packages to the versions in tevm's own package.json *and*
  `viem@2.37.0`. Then it works (`createMemoryClient` → block 0). Root cause: caret ranges on prerelease
  versions (`^1.0.0-next.148` admits `1.0.0-rc.151`). Fix is trivial for them; symptom of a fast-moving,
  small-team project — plan for pinning if you adopt it.

---

## 6. RPC surface for v1 (checklist)

**Node:** `eth_chainId net_version web3_clientVersion eth_syncing eth_blockNumber eth_getBlockByNumber
eth_getBlockByHash eth_getBlockTransactionCountByNumber eth_getBalance eth_getTransactionCount eth_getCode
eth_getStorageAt eth_gasPrice eth_maxPriorityFeePerGas eth_feeHistory eth_call eth_estimateGas
eth_sendRawTransaction eth_getTransactionByHash eth_getTransactionReceipt eth_getLogs eth_newFilter
eth_newBlockFilter eth_newPendingTransactionFilter eth_getFilterChanges eth_getFilterLogs eth_uninstallFilter
eth_subscribe eth_unsubscribe eth_createAccessList eth_simulateV1 (viem uses it when available)`

**Wallet:** `eth_accounts eth_requestAccounts eth_sendTransaction eth_signTransaction personal_sign
eth_signTypedData_v4 wallet_switchEthereumChain wallet_addEthereumChain wallet_getPermissions
wallet_requestPermissions wallet_revokePermissions wallet_getCapabilities wallet_sendCalls wallet_getCallsStatus`

**Cheatcodes (Anvil + Hardhat names):** `evm_mine anvil_mine evm_setAutomine evm_setIntervalMining
evm_setNextBlockTimestamp evm_increaseTime evm_snapshot evm_revert anvil_setBalance anvil_setCode
anvil_setNonce anvil_setStorageAt anvil_impersonateAccount anvil_stopImpersonatingAccount anvil_autoImpersonateAccount
anvil_setNextBlockBaseFeePerGas anvil_dropTransaction anvil_reset (refork) anvil_dumpState anvil_loadState`

**Sim-specific (`sim_*`):** `sim_mockContract sim_unmock sim_deal sim_follow sim_scriptWallet sim_scriptRpc
sim_exportFixture sim_importFixture`

Gas estimation: implement geth/Anvil-style binary search over `runTx` (the PoC uses a 1.3× heuristic).
Differential-test the whole surface against Anvil in CI (same txs → same receipts/logs/gas).

---

## 7. Roadmap

| Phase | Scope | Effort (1 eng) |
|---|---|---|
| **0 — Harden the PoC into a package** | Engine interface; RPC parity list above; `eth_subscribe` push; IndexedDB persister; `forkOverrides`; unit tests + Anvil differential tests (gas search, persistence and deal already done in the PoC) | 1–1.5 wk |
| **1 — Build & integrate** | `evmsim build` (Foundry `out/` → typed artifacts module) + Vite plugin; `defineSim` config + deploy plan + broadcast replay; EIP-6963 announce; viem transport helper; Playwright `installSim(page, config)`; Vitest helper; docs | 1–2 wk |
| **2 — Scenarios** | Fork cache (IndexedDB) + fixture export/import; follow mode with WS; actors DSL; JS mock DSL with events & custom-error reverts; wallet/RPC scripting (rejections, latency); Storybook decorator; dev toolbar (accounts, mine, time, snapshots) | 1–2 wk |
| **3 — Advanced** | SharedWorker multi-tab; cheatcode precompile so `forge script` setup runs in-browser; historical-state (last N blocks); EIP-5792 batch; L2 quirks (OP-Stack L1 fee precompile, Arbitrum precompiles) | as needed |
| **4 — WASM engine** | Swap the interpreter when Guillotine (or a revm-wasm) is stable: same interface, ~½ the bundle, faster | opportunistic |

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Engine drifts from the live chain (new opcodes/hardforks) | ethereumjs tracks forks promptly (Amsterdam already in 10.1); pin hardfork per chain in config; differential tests vs Anvil |
| Gas estimates differ from production | binary-search estimation; fork mode for realistic state; never assert exact gas in UI tests |
| L2 semantics (L1 data fee, chain-specific precompiles, tx types) | per-chain `common` + custom precompiles; fork the L2 for read paths |
| Public RPC rate limits / CORS / `eth_getProof` window in browser fork | fixture cache; fork a few blocks behind head; proxy through the dev server; access-list prefetch |
| Tevm (if adopted) version instability | exact pins + lockfile; or own the thin layer (recommended) |
| Bundle creep | CI size budget on the dev chunk; keep `zod`-class deps out; dev-only dynamic import |
| Simulator or test keys leaking into production | separate entry, `import.meta.env.DEV` guard, CI grep for the announce string / test keys |
| Non-determinism (timestamps, fork drift) | seedable clock; pinned fork block; fixtures committed |
| Concurrency bugs (interleaved checkpoints) | single async queue for all state work (already in PoC); actors run post-block |

---

## 9. Decision: adopt Tevm vs build the thin layer

**Recommendation: build the thin layer on `@ethereumjs/*` (own ~1.5–2k LOC), borrow from Tevm (MIT).**

- The PoC shows 70% of the surface in 400 lines; the remaining work is *product* (build plugin, DSLs,
  helpers), not EVM engineering.
- Direct dependency on ethereumjs = stable, browser-first, security-audited-ish, small controlled dep set;
  3× smaller bundle than Tevm today; no `zod`.
- Tevm's moving parts (engine rewrite, prerelease drift) become *your* release risk if you depend on it;
  yet its ideas (Anvil-compatible surface, `import './X.sol'` bundler, sync-storage persister, Guillotine) are
  worth tracking — and Guillotine is the natural future engine for §7 Phase 4.
- Keep the engine interface (§4.2) so the decision is reversible.

If you prefer not to own any EVM plumbing: pin Tevm exactly (all `@tevm/*` + viem), wrap it with the scenario
layer (§4.5–4.7) and the EIP-6963 announcer — those are the parts Tevm does not provide.

---

## Appendix A — PoC API (what exists in `evmsim-poc/src/sim.mjs`)

```ts
const sim = await createSim({ chainId, hardfork, keys, fork: { url, blockNumber }, mining: { mode }, baseFeePerGas, blockGasLimit, impersonateAll });
sim.provider            // EIP-1193: request({method, params}), on('message'|'accountsChanged'|…)
sim.accounts            // viem local accounts (Anvil keys) — signing for personal_sign / typed data
sim.mine(n) · sim.snapshot() · sim.revert(id) · sim.blockNumber
sim.mockContract(address, abi, handlers)          // JS handler per function; throw → revert
sim.onLog(filter, handler)                         // actors
sim.sendAs(from, tx)                               // impersonated tx from any address
sim.followChain(rpcUrl, { pollMs, onBlock })       // mirror live block numbers/timestamps
sim.announce(window)                               // EIP-6963 "Sim Wallet"
// state (§4b)
sim.deal(token, holder, amount, { adjustTotalSupply })      // any ERC20, slot discovery by SLOAD recording
sim.setState(address, storageLayout, { var: value, mapping: { key: value } })
sim.slotFromLayout(storageLayout, ['balanceOf', alice])    // for eth_call stateOverride
sim.dumpState() · sim.loadState(dump) · sim.replayJournal(dump.journal) · sim.journal · sim.flush()
createSim({ persist: { storage: localStorage, key } })     // auto-save after every block / cheat, restore on boot
createSim({ restore: dump })                                // fixtures (also fork fixtures: offline)
```

## Appendix B — References

- Tevm (Ethereum node for browser/Node; fork, mine, viem/Anvil actions): https://github.com/evmts/tevm · docs https://node.tevm.sh
- Guillotine (Zig EVM → WASM, ~110 KB claimed, alpha): https://github.com/evmts/guillotine
- EthereumJS monorepo, v10 browser-ready release notes: https://github.com/ethereumjs/ethereumjs-monorepo/blob/master/packages/vm/CHANGELOG.md
- `@ethereumjs/evm` (custom precompiles, hardforks): https://www.npmjs.com/package/@ethereumjs/evm
- revm (Rust EVM, `no_std`/wasm-capable): https://github.com/bluealloy/revm
- Solidity 0.8.21 — EWasm backend removed: https://www.soliditylang.org/blog/2023/07/19/solidity-0.8.21-release-announcement/
- JSPI status (Phase 4 April 2025; Chrome 137+, Firefox; Safari pending): https://github.com/web-platform-tests/interop/issues/1093 · https://platform.uno/blog/the-state-of-webassembly-2025-2026/
- EIP-6963 in wagmi v2 (`injected()` discovers by default): https://dev.to/grimicorn/connecting-wallets-the-right-way-wagmi-v2-and-eip-6963-4k02 · MetaMask docs https://docs.metamask.io/wallet/concepts/wallet-interoperability/
- wallet-mock (headless EIP-6963 wallet for Playwright): https://github.com/johanneskares/wallet-mock
- wagmi `mock` connector: https://wagmi.sh/react/connectors/mock
