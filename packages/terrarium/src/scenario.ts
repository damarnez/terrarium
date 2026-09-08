// scenario.ts — the declarative entry point: what runs inside the Worker when the Terrarium boots.
//
//   export default defineScenario({
//     chainId: 31337, seed: 1337, persist: 'my-dapp',
//     async setup(ctx) { await ctx.install(uniswap); if (ctx.fresh) { /* deploy + seed with ctx.wallet(...) */ } },
//     actors: [{ every: 5000, run: (ctx) => ... }, { on: { address, topics }, run: (ctx, log) => ... }],
//     status: (ctx) => ({ addresses: ctx.state }),
//   });
import type { Abi, Account, Address, Chain, Hex, PublicClient, TransactionReceipt, Transport, WalletClient } from 'viem';
import type { HttpRoute } from './http.ts';
export { reply } from './http.ts';
export type { HttpRoute, HttpRequest, HttpReply, GraphqlQuery, GraphqlResolver } from './http.ts';

/** Runtime bytecode of deployed contracts, installed at fixed addresses (`terrarium fetch-code` produces these). */
export interface Fixture { contracts: Record<string, { address: string; code: string }> }   // plain strings: JSON imports fit as-is
export interface LogFilter { address?: Address | Address[]; topics?: (Hex | Hex[] | null)[] }

export interface ScenarioContext {
  /** the engine itself: sim.deal, sim.setState, sim.sendAs, sim.onLog, sim.snapshot ... */
  sim: any;
  chainId: number;
  /** the 10 Anvil test accounts, each with 10,000 ETH; the wallet exposes all of them */
  accounts: Address[];
  /** raw JSON-RPC against the chain (cheatcodes included) */
  rpc(method: string, params?: unknown[]): Promise<any>;
  /** viem clients wired to the chain */
  pub: PublicClient;
  wallet(account: Address): WalletClient<Transport, Chain, Account>;
  wait(hash: Promise<Hex> | Hex): Promise<TransactionReceipt>;
  /** a deadline from the CHAIN clock (never Date.now(): the dev bar can shift time) */
  deadline(seconds?: number): bigint;
  /** seeded PRNG: reproducible actors */
  random(): number;
  /** true when the chain has no blocks yet (first boot, or after a reset): deploy and seed only then */
  fresh: boolean;
  /** true when nothing was persisted yet (first boot or after a reset), even if a fixture was restored: seed the user once */
  firstBoot: boolean;
  codeAt(address: Address): Promise<Hex>;
  /** put a fixture on the chain, safe on every boot. A code fixture (`terrarium fetch-code`) writes each contract's
   *  bytecode where there is none yet. An Anvil state dump (`terrarium import-anvil`, or `anvil_dumpState` by hand)
   *  writes whole accounts (code, storage, nonce, balance) through `anvil_loadState`: contracts that already have code
   *  are skipped, accounts without code (the deployer's nonce, funded EOAs) are only written on a fresh chain */
  install(fixture: Fixture | AnvilStateFixture): Promise<void>;
  /** name an address in the transaction explorer and, optionally, give the ABI that decodes calls to it, its events and its
   *  custom errors: `ctx.label(pair, 'PEPE/WETH pair', pairAbi)`. `install(fixture)` labels contracts by their fixture keys */
  label(address: Address | string, name: string, abi?: Abi): void;
  /** ask the page to reload: for a method that reset or rebuilt the chain and wants the dapp to start over on it */
  reload(): void;
  /** a bag for whatever setup() discovers (addresses...) that actors and status() need later */
  state: Record<string, any>;
}

/** what `anvil_dumpState` / `anvil --dump-state` produce (and `terrarium import-anvil` writes): whole accounts */
export interface AnvilStateFixture {
  accounts: Record<string, { nonce?: number | string; balance?: string; code?: Hex; storage?: Record<string, string> } | null>;
  [extra: string]: unknown;
}

export interface Actor {
  name?: string;
  /** run from the first boot, outside the actors toggle: a keeper the protocol cannot work without (an oracle answering
   *  requests) belongs here; other people trading belongs in the toggled actors */
  always?: boolean;
  /** run every N ms */
  every?: number;
  /** ...or run when a matching log is mined (a function, if the filter depends on setup() results) */
  on?: LogFilter | ((ctx: ScenarioContext) => LogFilter);
  run(ctx: ScenarioContext, log?: any): Promise<unknown> | unknown;
}

export interface ScenarioConfig {
  chainId?: number;
  /** seed for ctx.random() and the actors; omit for a fresh seed per boot */
  seed?: number;
  /** IndexedDB key the chain persists under; false = in-memory only */
  persist?: string | false;
  hardfork?: string;
  /** 'merkle' (default): real stateRoot in every header. 'simple': flat maps, placeholder root. */
  state?: 'merkle' | 'simple';
  /** fork a live chain: state is read lazily from `url` at `blockNumber` (and recorded). `offline: true` forbids the
   *  network: reads the fixture cannot answer throw and are listed in sim.offlineMisses. */
  fork?: { url?: string; blockNumber: number; offline?: boolean };
  /** the chain clock. 'wall' (default): the wall clock. 'recording': the wall clock re-based to the restored fixture's last
   *  block, so oracles with staleness checks keep working however long ago the fixture was recorded. A number: fixed seconds
   *  (blocks then advance one second at a time, plus whatever evm_increaseTime adds). */
  clock?: 'wall' | 'recording' | number;
  /** a recorded dump (sim.dumpState(), e.g. from a fork recording) used as the baseline when nothing is persisted yet */
  restore?: Record<string, any> | (() => Promise<Record<string, any>>);
  /** extra buttons for the dev bar: each calls one of your `methods` (or any RPC method) with fixed params */
  controls?: { label: string; method: string; params?: unknown[]; title?: string }[];
  /** 'exact' (geth-style estimation, default) or 'fast' (block gas limit, no estimation) */
  gasEstimation?: 'exact' | 'fast';
  /** how the wallet misbehaves, from the start (all changeable at runtime via terrarium_setWallet) */
  wallet?: { rejectNext?: number; latencyMs?: number; receiptLagMs?: number };
  /** runs on EVERY boot; use ctx.fresh to deploy/seed once, ctx.install for fixtures (idempotent) */
  setup?(ctx: ScenarioContext): Promise<unknown> | unknown;
  /** background actors: other users, keepers, arbitrageurs. Toggled together (dev bar / terrarium_actors), off by default. */
  actors?: Actor[];
  /** what the dev bar calls the actors toggle, e.g. "Pond life" */
  actorsLabel?: string;
  /** extra fields for terrarium_status (addresses, whatever the dev bar / tests want to know) */
  status?(ctx: ScenarioContext): Promise<Record<string, unknown>> | Record<string, unknown>;
  /** extra RPC methods, reachable through the provider: methods: { terrarium_faucet: (ctx, to) => ... } */
  methods?: Record<string, (ctx: ScenarioContext, ...args: any[]) => unknown>;
  /** HTTP calls of the dapp to answer from the chain (subgraphs, price APIs, your backend): the page's `fetch` is
   *  intercepted for matching URLs, the handler runs here in the Worker with `ctx`, everything else goes to the network.
   *  http: [{ match: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2', graphql: { swaps: (ctx, q) => … } }] */
  http?: HttpRoute[];
  /** extra ABIs for the transaction explorer (`terrarium_transactions`): calls, events and custom errors decode with an
   *  address's own ABI (`ctx.label(address, name, abi)`) first, then these, then the built-in set of standard events, functions
   *  and errors (ERC-20/721/1155/4626, WETH, Uniswap V2, Ownable, proxies, OpenZeppelin errors). Anything left is shown raw */
  abis?: Abi[];
  /** names for addresses known up front (`{ [ROUTER]: 'Uniswap V2 Router' }`); for addresses discovered in setup use
   *  `ctx.label(address, name)`. The sim's accounts are `Account #i` unless named */
  labels?: Record<string, string>;
}

export function defineScenario(config: ScenarioConfig): ScenarioConfig { return config; }
