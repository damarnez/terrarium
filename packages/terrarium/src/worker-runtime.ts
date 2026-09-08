// worker-runtime.ts — runs a scenario inside the Worker: boot the chain, run setup(), wire the actors, expose the
// generic terrarium_* controls, and serve the provider to the page over postMessage.
import { createPublicClient, createWalletClient, custom, defineChain, decodeErrorResult, decodeEventLog, decodeFunctionData, toEventSelector, toHex, type Abi, type Address, type Hex } from 'viem';
import { KNOWN_ABI } from './known-abi.ts';
// @ts-ignore — the engine is plain ESM JavaScript
import { createTerrarium, indexedDBStorage } from './engine.js';
import { serveProvider } from './bridge.ts';
import { runRoute, toWire } from './http.ts';
import type { Actor, ScenarioConfig, ScenarioContext, ScenarioInput } from './scenario.ts';

type Storage = { getItem(k: string): Promise<any>; setItem(k: string, v: any): Promise<any>; removeItem(k: string): Promise<any>; clear(): Promise<any> };
const SELECTION_KEY = 'terrarium:scenario';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'scenario';
const nameOf = (s: ScenarioConfig, i: number) => s.name ?? `Scenario ${i + 1}`;

/** Boot one scenario, or the active one of a list (the dev bar's selector picks; the choice is stored so a reload keeps it).
 *  `opts.storage` replaces IndexedDB (tests). */
export async function runScenario(input: ScenarioInput, opts: { storage?: Storage } = {}) {
  const list = Array.isArray(input) ? input : [input];
  if (!list.length) throw new Error('runScenario: no scenario');
  const names = list.map(nameOf);
  const anyPersist = list.some((s) => s.persist !== false);
  const store: Storage | null = opts.storage ?? (anyPersist ? indexedDBStorage('terrarium') : null);
  const selected = list.length > 1 && store ? await store.getItem(SELECTION_KEY) : null;
  const index = Math.max(0, names.indexOf(selected));
  const config = list[index], scenarioName = names[index];
  const chainId = config.chainId ?? 31337;
  // the page learns what to intercept before the chain boots, so the dapp's first fetches are not held up by setup()
  const httpRoutes = toWire(config.http ?? []);
  if (typeof (globalThis as any).postMessage === 'function') (globalThis as any).postMessage({ event: 'httpRoutes', payload: httpRoutes });
  let httpHits = 0;
  // a listed scenario persists under its own slug unless it says otherwise, so switching back finds its chain again
  const key = config.persist === false ? null : (config.persist ?? (list.length > 1 ? slug(scenarioName) : 'default'));
  const storage = key ? store : null;
  const firstBoot = storage ? (await storage.getItem(key!)) === null : true;
  const restore = typeof config.restore === 'function' ? await config.restore() : config.restore;
  const bootWall = Math.floor(Date.now() / 1000);
  const anchor = config.clock === 'recording' ? Number(BigInt(restore?.chain?.blocks?.at(-1)?.timestamp ?? bootWall)) : null;
  const clock = typeof config.clock === 'number' ? () => config.clock as number : anchor !== null ? () => anchor + (Math.floor(Date.now() / 1000) - bootWall) : undefined;
  const sim: any = await createTerrarium({ chainId, seed: config.seed, hardfork: config.hardfork, state: config.state, gasEstimation: config.gasEstimation, wallet: config.wallet, fork: config.fork, restore, clock, persist: storage ? { storage, key } : undefined });
  const chain = defineChain({ id: chainId, name: 'Terrarium', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
  const pub = createPublicClient({ chain, transport: custom(sim.provider), pollingInterval: 20 });
  const rpc = (method: string, params: unknown[] = []) => sim.provider.request({ method, params });
  // what the explorer knows about addresses: a name and/or an ABI, from ctx.label() and from install()'s fixture keys
  const registry = new Map<string, { name?: string; auto?: boolean; abi?: Abi }>();
  const ctx: ScenarioContext = {
    sim, chainId, rpc, pub,
    accounts: sim.accounts.map((a: any) => a.address as Address),
    wallet: (account) => createWalletClient({ chain, transport: custom(sim.provider), account }),
    wait: async (h) => pub.waitForTransactionReceipt({ hash: await h }),
    deadline: (seconds = 3600) => sim.now() + BigInt(seconds),
    random: () => sim.random(),
    fresh: sim.blockNumber === 0n,
    firstBoot,
    codeAt: async (a) => (await rpc('eth_getCode', [a, 'latest'])) as Hex,
    install: async (fixture: any) => {
      // names and ABIs the fixture carries (import-anvil --broadcast/--artifacts, or written by hand): the explorer uses them
      for (const [a, name] of Object.entries((fixture?.names ?? {}) as Record<string, string>)) { const k = a.toLowerCase(); registry.set(k, { ...registry.get(k), name, auto: true }); }
      for (const [a, abi] of Object.entries((fixture?.abis ?? {}) as Record<string, Abi>)) { const k = a.toLowerCase(); registry.set(k, { ...registry.get(k), abi }); }
      // an Anvil state dump (`terrarium import-anvil`, or anvil_dumpState by hand): whole accounts, code and storage,
      // through anvil_loadState. Idempotent like the code fixtures: an account that already has code is left alone, and
      // accounts without code (the deployer's nonce, funded EOAs) are only written on a fresh chain.
      if (fixture?.accounts && !fixture.contracts) {
        const accounts: Record<string, any> = {};
        for (const [a, acct] of Object.entries(fixture.accounts as Record<string, any>)) {
          if (!acct) continue;
          const hasCode = acct.code && acct.code !== '0x';
          if (hasCode ? (await ctx.codeAt(a as Address)) === '0x' : ctx.fresh) accounts[a] = acct;
        }
        if (Object.keys(accounts).length) await rpc('anvil_loadState', [{ accounts }]);
        return;
      }
      for (const [key, c] of Object.entries(fixture.contracts) as [string, any][]) {
        const k = c.address.toLowerCase(); if (!registry.get(k)?.name) registry.set(k, { ...registry.get(k), name: key, auto: true });   // the explorer names it by its fixture key
        if ((await ctx.codeAt(c.address as Address)) === '0x') await rpc('anvil_setCode', [c.address, c.code]);
      }
    },
    label: (address, name, abi) => { const k = address.toLowerCase(); registry.set(k, { ...registry.get(k), name, auto: false, ...(abi ? { abi } : {}) }); },
    // the page reloads (a scenario that reset the chain, or rebuilt it, wants the dapp to start over on the new state)
    reload: () => { if (typeof (globalThis as any).postMessage === 'function') (globalThis as any).postMessage({ event: 'reload', payload: null }); },
    state: {},
  };
  await config.setup?.(ctx);
  if (ctx.fresh && storage) await sim.flush();

  // ---- actors: toggled together, persisted, off by default; `always` actors run regardless (keepers the protocol needs) ---
  const wire = (a: Actor) => {
    const safe = (log?: any) => Promise.resolve().then(() => a.run(ctx, log)).catch((e) => console.warn(`[terrarium] actor ${a.name ?? ''} failed:`, e?.message ?? e));
    const out: (() => void)[] = [];
    if (a.every) { const t = setInterval(() => safe(), a.every); out.push(() => clearInterval(t)); }
    if (a.on) out.push(sim.onLog(typeof a.on === 'function' ? a.on(ctx) : a.on, (log: any) => safe(log)));
    return out;
  };
  const toggled = (config.actors ?? []).filter((a) => !a.always);
  for (const a of (config.actors ?? []).filter((a) => a.always)) wire(a);
  const actorsKey = `${key}:actors`;
  let unsubs: (() => void)[] = [];
  const actors = {
    enabled: storage ? (await storage.getItem(actorsKey)) === 'on' : false,
    async toggle(on: boolean) {
      actors.enabled = on; await storage?.setItem(actorsKey, on ? 'on' : 'off');
      unsubs.forEach((u) => u()); unsubs = [];
      if (!on) return;
      for (const a of toggled) unsubs.push(...wire(a));
    },
  };
  if (actors.enabled) await actors.toggle(true);

  // ---- generic controls, reachable through the provider like any RPC method -----------------------------------
  sim.addMethod('terrarium_actors', async (on?: boolean) => { await actors.toggle(on ?? !actors.enabled); return actors.enabled; });
  sim.addMethod('terrarium_status', async () => ({ scenario: scenarioName, chainId, engine: sim.engine, block: toHex(sim.blockNumber), accounts: ctx.accounts, actors: actors.enabled, actorsLabel: config.actorsLabel ?? 'Actors', hasActors: toggled.length > 0, wallet: { ...sim.wallet }, controls: config.controls ?? [], restoredFromPersistence: sim.restoredFromPersistence, localBlocks: Number(sim.blockNumber) - (config.fork ? config.fork.blockNumber + 1 : 0), http: { routes: httpRoutes.length, hits: httpHits }, fork: config.fork ? { blockNumber: config.fork.blockNumber, offline: !!config.fork.offline, misses: sim.offlineMisses.length } : null, ...(await config.status?.(ctx)) }));
  // ---- the transaction explorer: the engine's list, decoded (address's own ABI, then `abis`, then the known set) and labelled
  const configAbi = (config.abis ?? []).flat() as Abi;
  const abisFor = (address: string | null): Abi[] => [registry.get((address ?? '').toLowerCase())?.abi, configAbi, KNOWN_ABI].filter((a): a is Abi => !!a && a.length > 0);
  const labelsOf = () => {
    const out: Record<string, string> = {};
    ctx.accounts.forEach((a, i) => { out[a.toLowerCase()] = i === 0 ? 'You (#0)' : `Account #${i}`; });   // accounts[0] is the browser user
    for (const [a, e] of registry) if (e.name && e.auto) out[a] = e.name;                            // fixture keys
    for (const [a, name] of Object.entries(config.labels ?? {})) if (a) out[a.toLowerCase()] = name;   // the config
    for (const [a, e] of registry) if (e.name && !e.auto) out[a] = e.name;                           // ctx.label() wins
    return out;
  };
  const plain = (v: any): any => typeof v === 'bigint' ? v.toString() : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v;
  const first = <T,>(items: readonly any[], fn: (item: any) => T | null): T | null => { for (const item of items) { try { const r = fn(item); if (r) return r; } catch {} } return null; };
  const decodeCall = (to: string, data: Hex) => first(abisFor(to), (abi: Abi) => { const d = decodeFunctionData({ abi, data }); return { name: d.functionName, args: plain(d.args ?? []) }; });
  const decodeRevert = (to: string | null, data: Hex) => first(abisFor(to), (abi: Abi) => { const d = decodeErrorResult({ abi, data }); return { name: d.errorName, args: plain(d.args ?? []) }; });
  // events: every candidate with the log's topic0 is tried (ERC-20 and ERC-721 Transfer share it and differ in indexed params)
  const decodeLog = (l: { address: string; topics: Hex[]; data: Hex }) => first(abisFor(l.address), (abi: Abi) => first(abi.filter((i) => i.type === 'event' && toEventSelector(i as any) === l.topics[0]), (item: any) => { const d: any = decodeEventLog({ abi: [item], data: l.data, topics: l.topics as [Hex, ...Hex[]] }); return { name: d.eventName as string, args: plain(d.args ?? {}) }; }));
  sim.addMethod('terrarium_transactions', (opts?: { limit?: number; before?: string }) => {
    const { total, transactions } = sim.transactions(opts ?? {});
    return { total, labels: labelsOf(), transactions: transactions.map((t: any) => {
      const hasData = t.input && t.input.length >= 10;
      const method = !t.to ? { name: 'create', args: [] } : hasData ? decodeCall(t.to, t.input) ?? { name: null, selector: t.input.slice(0, 10) } : null;
      const revert = t.status === 'reverted' && t.revertData && t.revertData !== '0x' ? decodeRevert(t.to, t.revertData) : null;
      const logs = (t.receipt?.logs ?? []).map((l: any) => ({ ...l, decoded: decodeLog(l) }));
      return { ...t, method, revert, logs };
    }) };
  });
  // reset wipes this scenario's chain (its key and its actors flag); other scenarios and the selection stay
  sim.addMethod('terrarium_reset', async () => { await actors.toggle(false); sim.stop(); if (storage && key) { await storage.removeItem(key); await storage.removeItem(actorsKey); } return true; });
  // several scenarios: the list for the selector, and the switch (stored, then the page reloads and boots the chosen one)
  sim.addMethod('terrarium_scenarios', () => ({ active: scenarioName, scenarios: list.map((s, i) => ({ name: names[i], description: s.description ?? null, persist: s.persist === false ? null : (s.persist ?? (list.length > 1 ? slug(names[i]) : 'default')) })) }));
  sim.addMethod('terrarium_selectScenario', async (name: string) => {
    if (!names.includes(name)) throw new Error(`no scenario named ${JSON.stringify(name)}; have: ${names.join(', ')}`);
    if (name !== scenarioName) { await store?.setItem(SELECTION_KEY, name); await actors.toggle(false); sim.stop(); ctx.reload(); }
    return name;
  });
  for (const [name, fn] of Object.entries(config.methods ?? {})) sim.addMethod(name, (...args: any[]) => fn(ctx, ...args));

  // ---- HTTP routes: the page's fetch forwards matching requests here; the handler answers from the chain --------------
  sim.addMethod('terrarium_httpRoutes', () => httpRoutes);
  sim.addMethod('terrarium_http', async (index: number, raw: { url: string; method: string; headers?: Record<string, string>; body?: string | null }) => {
    const route = (config.http ?? [])[index]; if (!route) throw new Error(`no http route ${index}`);
    httpHits++; return runRoute(ctx, route, raw);
  });

  serveProvider(sim.provider);
  return sim;
}
