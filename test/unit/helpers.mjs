// test/unit/helpers.mjs — shared plumbing for the unit suite: a Terrarium with a fixed clock and seed, viem clients on
// its provider, the PEPE artifact, and an in-memory persistence store.
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, custom, defineChain, parseEther } from 'viem';
import { createTerrarium } from 'terrarium/engine';

export const PEPE = JSON.parse(readFileSync(new URL('../../contracts/out/PEPE.json', import.meta.url), 'utf8'));
export const GENESIS_TS = 1_700_000_000;
export const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/fork-mainnet-usdc-swap.json', import.meta.url), 'utf8'));

/** a Terrarium whose clock stands still (blocks then advance one second at a time) with a fixed seed */
export async function boot(opts = {}) {
  const sim = await createTerrarium({ clock: () => GENESIS_TS, seed: 1, ...opts });
  const chain = defineChain({ id: sim.chainId, name: 'test', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
  const pub = createPublicClient({ chain, transport: custom(sim.provider), pollingInterval: 5 });
  const wallet = (account) => createWalletClient({ chain, transport: custom(sim.provider), account });
  const rpc = (method, params = []) => sim.provider.request({ method, params });
  return { sim, pub, wallet, rpc, chain, accounts: sim.accounts.map((a) => a.address) };
}

/** deploy PEPE from `from` (default: account 9, the treasury) and return its address */
export async function deployPepe(t, from = t.accounts[9], supply = parseEther('1000000')) {
  const hash = await t.wallet(from).deployContract({ abi: PEPE.abi, bytecode: PEPE.bytecode, args: [supply] });
  const r = await t.pub.waitForTransactionReceipt({ hash });
  return r.contractAddress;
}

/** the persistence store shape (getItem/setItem/removeItem/clear), in memory */
export const memoryStorage = () => { const m = new Map(); return { getItem: async (k) => m.get(k) ?? null, setItem: async (k, v) => { m.set(k, v); }, removeItem: async (k) => { m.delete(k); }, clear: async () => m.clear(), map: m }; };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rejects = async (p, check) => { try { await p; } catch (e) { check(e); return e; } throw new Error('expected a rejection'); };
