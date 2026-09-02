// worker-runtime.ts — runs a scenario inside the Worker: boot the chain, run setup(), wire the actors, expose the
// generic terrarium_* controls, and serve the provider to the page over postMessage.
import { createPublicClient, createWalletClient, custom, defineChain, toHex, type Address, type Hex } from 'viem';
// @ts-ignore — the engine is plain ESM JavaScript
import { createTerrarium, indexedDBStorage } from './engine.js';
import { serveProvider } from './bridge';
import type { ScenarioConfig, ScenarioContext } from './scenario';

export async function runScenario(config: ScenarioConfig) {
  const chainId = config.chainId ?? 31337;
  const key = config.persist === false ? null : (config.persist ?? 'default');
  const storage = key ? indexedDBStorage('terrarium') : null;
  const sim: any = await createTerrarium({ chainId, seed: config.seed, hardfork: config.hardfork, engine: config.engine ?? 'revm', state: config.state, gasEstimation: config.gasEstimation, wallet: config.wallet, persist: storage ? { storage, key } : undefined });
  const chain = defineChain({ id: chainId, name: 'Terrarium', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
  const pub = createPublicClient({ chain, transport: custom(sim.provider), pollingInterval: 20 });
  const rpc = (method: string, params: unknown[] = []) => sim.provider.request({ method, params });
  const ctx: ScenarioContext = {
    sim, chainId, rpc, pub,
    accounts: sim.accounts.map((a: any) => a.address as Address),
    wallet: (account) => createWalletClient({ chain, transport: custom(sim.provider), account }),
    wait: async (h) => pub.waitForTransactionReceipt({ hash: await h }),
    deadline: (seconds = 3600) => sim.now() + BigInt(seconds),
    random: () => sim.random(),
    fresh: sim.blockNumber === 0n,
    codeAt: async (a) => (await rpc('eth_getCode', [a, 'latest'])) as Hex,
    install: async (fixture) => { for (const c of Object.values(fixture.contracts)) if ((await ctx.codeAt(c.address as Address)) === '0x') await rpc('anvil_setCode', [c.address, c.code]); },
    state: {},
  };
  await config.setup?.(ctx);
  if (ctx.fresh && storage) await sim.flush();

  // ---- actors: toggled together, persisted, off by default ----------------------------------------------------
  const actorsKey = `${key}:actors`;
  let timers: ReturnType<typeof setInterval>[] = [], unsubs: (() => void)[] = [];
  const actors = {
    enabled: storage ? (await storage.getItem(actorsKey)) === 'on' : false,
    async toggle(on: boolean) {
      actors.enabled = on; await storage?.setItem(actorsKey, on ? 'on' : 'off');
      timers.forEach(clearInterval); timers = []; unsubs.forEach((u) => u()); unsubs = [];
      if (!on) return;
      for (const a of config.actors ?? []) {
        const safe = (log?: any) => Promise.resolve(a.run(ctx, log)).catch((e) => console.warn(`[terrarium] actor ${a.name ?? ''} failed:`, e?.message ?? e));
        if (a.every) timers.push(setInterval(() => safe(), a.every));
        if (a.on) unsubs.push(sim.onLog(typeof a.on === 'function' ? a.on(ctx) : a.on, (log: any) => safe(log)));
      }
    },
  };
  if (actors.enabled) await actors.toggle(true);

  // ---- generic controls, reachable through the provider like any RPC method -----------------------------------
  sim.addMethod('terrarium_actors', async (on?: boolean) => { await actors.toggle(on ?? !actors.enabled); return actors.enabled; });
  sim.addMethod('terrarium_status', async () => ({ chainId, engine: sim.engine, block: toHex(sim.blockNumber), accounts: ctx.accounts, actors: actors.enabled, actorsLabel: config.actorsLabel ?? 'Actors', hasActors: (config.actors?.length ?? 0) > 0, wallet: { ...sim.wallet }, ...(await config.status?.(ctx)) }));
  sim.addMethod('terrarium_reset', async () => { await actors.toggle(false); sim.stop(); await storage?.clear(); return true; });
  for (const [name, fn] of Object.entries(config.methods ?? {})) sim.addMethod(name, (...args: any[]) => fn(ctx, ...args));

  serveProvider(sim.provider);
  return sim;
}
