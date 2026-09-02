// scenario.ts — the declarative entry point: what runs inside the Worker when the Terrarium boots.
//
//   export default defineScenario({
//     chainId: 31337, seed: 1337, persist: 'my-dapp',
//     async setup(ctx) { await ctx.install(uniswap); if (ctx.fresh) { /* deploy + seed with ctx.wallet(...) */ } },
//     actors: [{ every: 5000, run: (ctx) => ... }, { on: { address, topics }, run: (ctx, log) => ... }],
//     status: (ctx) => ({ addresses: ctx.state }),
//   });
import type { Account, Address, Chain, Hex, PublicClient, TransactionReceipt, Transport, WalletClient } from 'viem';

/** Runtime bytecode of deployed contracts, installed at fixed addresses (`terrarium fetch-code` produces these). */
export interface Fixture { contracts: Record<string, { address: string; code: string }> }   // plain strings: JSON imports fit as-is
export interface LogFilter { address?: Address | Address[]; topics?: (Hex | Hex[] | null)[] }

export interface ScenarioContext {
  /** the engine itself: sim.deal, sim.setState, sim.sendAs, sim.onLog, sim.mockContract, sim.snapshot ... */
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
  codeAt(address: Address): Promise<Hex>;
  /** put a fixture's bytecode at its addresses (skips contracts already present, so it is safe on every boot) */
  install(fixture: Fixture): Promise<void>;
  /** a bag for whatever setup() discovers (addresses...) that actors and status() need later */
  state: Record<string, any>;
}

export interface Actor {
  name?: string;
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
  /** execution engine: 'revm' (revm compiled to WebAssembly, fast) or 'js' (@ethereumjs/vm, the reference). Default 'revm'. */
  engine?: 'revm' | 'js';
  /** 'merkle' (default): real stateRoot in every header. 'simple': flat maps, placeholder root. */
  state?: 'merkle' | 'simple';
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
}

export function defineScenario(config: ScenarioConfig): ScenarioConfig { return config; }
