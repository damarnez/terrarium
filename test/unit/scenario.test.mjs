// The scenario runtime (what the Worker runs) driven in Node: setup context, actors, status, controls, methods,
// the recording clock, fork status, reset. Worker globals are shimmed; persistence is off (IndexedDB is browser-only,
// the e2e covers the reload path).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, parseEther, toHex } from 'viem';
import { runScenario } from '@terrariumlabs/core/worker';
import { PEPE, FIXTURE, sleep, until, memoryStorage } from './helpers.mjs';

const posted = [];
before(() => { globalThis.postMessage = (m) => posted.push(m); });
const uniswap = JSON.parse(readFileSync(new URL('../../packages/terrarium/fixtures/uniswap-v2-mainnet.json', import.meta.url), 'utf8'));
const TRANSFER = keccak256(toHex('Transfer(address,address,uint256)'));

test('setup gets a working ctx: accounts, fresh/firstBoot, install (idempotent), deploy, deadline from the chain clock, seeded random', async () => {
  let seen;
  const sim = await runScenario({ chainId: 31337, seed: 5, persist: false, clock: 1_700_000_000, async setup(ctx) {
    seen = { accounts: ctx.accounts.length, fresh: ctx.fresh, firstBoot: ctx.firstBoot, chainId: ctx.chainId, deadline: ctx.deadline(60), random: ctx.random() };
    await ctx.install(uniswap); await ctx.install(uniswap);
    seen.routerCode = (await ctx.codeAt(uniswap.contracts.router.address)).length > 2;
    const t = ctx.wallet(ctx.accounts[9]);
    const r = await ctx.wait(t.deployContract({ abi: PEPE.abi, bytecode: PEPE.bytecode, args: [parseEther('1')] }));
    ctx.state.pepe = r.contractAddress;
    seen.blockAfterDeploy = await ctx.rpc('eth_blockNumber');
  }, status: (ctx) => ({ pepe: ctx.state.pepe }) });
  const { deadline, random, ...rest } = seen;
  assert.deepEqual(rest, { accounts: 10, fresh: true, firstBoot: true, chainId: 31337, routerCode: true, blockAfterDeploy: '0x1' });
  assert.equal(deadline, 1_700_000_060n); assert.ok(random >= 0 && random < 1);
  assert.equal(sim.journal.filter((e) => e.method === 'anvil_setCode').length, 3, 'install writes each contract once');
  assert.equal(posted.at(-1).event, 'ready');
  const st = await sim.provider.request({ method: 'terrarium_status' });
  assert.equal(st.chainId, 31337); assert.equal(st.engine, 'revm'); assert.equal(st.block, '0x1'); assert.equal(st.accounts.length, 10);
  assert.equal(st.actors, false); assert.equal(st.hasActors, false); assert.equal(st.actorsLabel, 'Actors'); assert.deepEqual(st.controls, []);
  assert.equal(st.restoredFromPersistence, false); assert.equal(st.localBlocks, 1); assert.equal(st.fork, null); assert.match(st.pepe, /^0x/);
  assert.deepEqual(st.wallet, { rejectNext: 0, latencyMs: 0, receiptLagMs: 0 });
});

test('actors: off by default, toggled together, timers and log reactions, errors contained', async () => {
  let ticks = 0, reactions = [], failures = 0;
  const warn = console.warn; console.warn = (...a) => { failures++; };
  try {
    const sim = await runScenario({ persist: false, clock: 1, actorsLabel: 'Pond life', controls: [{ label: 'X', method: 'terrarium_x' }],
      actors: [
        { name: 'ticker', every: 15, run: () => { ticks++; } },
        { name: 'reactor', on: (ctx) => ({ address: ctx.state.pepe, topics: [TRANSFER] }), run: (ctx, log) => { reactions.push(log.blockNumber); } },
        { name: 'broken', every: 15, run: () => { throw new Error('boom'); } },
      ],
      async setup(ctx) { const r = await ctx.wait(ctx.wallet(ctx.accounts[9]).deployContract({ abi: PEPE.abi, bytecode: PEPE.bytecode, args: [parseEther('1')] })); ctx.state.pepe = r.contractAddress; ctx.state.t = ctx.wallet(ctx.accounts[9]); },
      methods: { terrarium_x: (ctx, n = 1) => ctx.accounts.length * n } });
    const rpc = (m, p = []) => sim.provider.request({ method: m, params: p });
    const st0 = await rpc('terrarium_status');
    assert.equal(st0.hasActors, true); assert.equal(st0.actorsLabel, 'Pond life'); assert.deepEqual(st0.controls, [{ label: 'X', method: 'terrarium_x' }]);
    assert.equal(await rpc('terrarium_x', [3]), 30, 'methods receive ctx then params');
    await sleep(40); assert.equal(ticks, 0, 'off by default');
    assert.equal(await rpc('terrarium_actors'), true);
    await until(() => ticks >= 2 && failures >= 1, 3000, 'two ticks and one logged failure (a throwing actor is logged, not fatal)');
    await rpc('eth_sendTransaction', [{ from: sim.accounts[9].address, to: pepeAddr(sim), data: '0xa9059cbb' + sim.accounts[1].address.slice(2).padStart(64, '0') + (1n).toString(16).padStart(64, '0') }]);
    await until(() => reactions.length >= 1, 3000, 'the log reaction'); assert.equal(reactions.length, 1);
    assert.equal(await rpc('terrarium_actors', [false]), false);
    const t = ticks; await sleep(50); assert.equal(ticks, t, 'stopped');
    assert.equal((await rpc('terrarium_status')).actors, false);
  } finally { console.warn = warn; }
});
// the PEPE address of a scenario that deployed it as the treasury's first tx
import { getContractAddress } from 'viem';
const pepeAddr = (sim) => getContractAddress({ from: sim.accounts[9].address, nonce: 0n });

test('fixture-backed scenario: fork + restore + recording clock, fork status with misses, firstBoot vs fresh', async () => {
  let ctxSeen;
  const anchor = Number(BigInt(FIXTURE.dump.chain.blocks.at(-1).timestamp));
  const net = globalThis.fetch; globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    const sim = await runScenario({ chainId: 1, persist: false, fork: { blockNumber: FIXTURE.blockNumber, offline: true }, restore: async () => FIXTURE.dump, clock: 'recording',
      setup(ctx) { ctxSeen = { fresh: ctx.fresh, firstBoot: ctx.firstBoot }; } });
    assert.deepEqual(ctxSeen, { fresh: false, firstBoot: true }, 'a forked chain is never at block 0; firstBoot is the once-only hook');
    const now = Number(sim.now()); assert.ok(now >= anchor && now < anchor + 5, `clock re-based to the recording: ${now} vs ${anchor}`);
    const rpc = (m, p = []) => sim.provider.request({ method: m, params: p });
    const st = await rpc('terrarium_status');
    assert.deepEqual(st.fork, { blockNumber: FIXTURE.blockNumber, offline: true, misses: 0 }); assert.equal(st.localBlocks, 2);
    await rpc('eth_getBalance', ['0x00000000000000000000000000000000000000E5', 'latest']).catch(() => {});
    assert.equal((await rpc('terrarium_status')).fork.misses, 1);
    assert.equal(await rpc('terrarium_reset'), true);
  } finally { globalThis.fetch = net; }
});

test('a numeric clock freezes time: blocks advance one second at a time from it', async () => {
  const sim = await runScenario({ persist: false, clock: 1_600_000_000, gasEstimation: 'fast', wallet: { latencyMs: 0 } });
  await sim.provider.request({ method: 'evm_mine' }); await sim.provider.request({ method: 'evm_mine' });
  assert.equal(Number((await sim.provider.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })).timestamp), 1_600_000_002);
});

test('ctx.install with an Anvil dump: contracts once, EOAs only on a fresh chain; ctx.reload posts to the page', async () => {
  const contract = '0x00000000000000000000000000000000000000cc';
  const dump = { source: 'anvil', accounts: { [contract]: { nonce: 1, balance: '0x0', code: '0x5f545f5260205ff3', storage: { '0x0': '0x2a' } }, '0x00000000000000000000000000000000000000dd': { nonce: 3, balance: '0x64' } } };
  let seen;
  const sim = await runScenario({ persist: false, clock: 1, async setup(ctx) {
    await ctx.install(dump);
    // a second install is a no-op for the contract (code present) and, the chain no longer fresh after the first write? no:
    // no block was mined, so the EOA would be written again; make the chain non-fresh and check nothing else lands
    await ctx.rpc('evm_mine'); ctx.fresh = false;
    await ctx.install(dump);
    seen = { code: await ctx.codeAt(contract), slot: await ctx.rpc('eth_getStorageAt', [contract, '0x0', 'latest']), nonce: await ctx.rpc('eth_getTransactionCount', ['0x00000000000000000000000000000000000000dd', 'latest']) };
    ctx.reload();
  } });
  assert.equal(seen.code, '0x5f545f5260205ff3'); assert.equal(seen.slot, '0x' + '2a'.padStart(64, '0')); assert.equal(seen.nonce, '0x3');
  assert.equal(sim.journal.filter((e) => e.method === 'anvil_loadState').length, 1, 'the second install wrote nothing');
  assert.ok(posted.some((m) => m.event === 'reload'), 'ctx.reload() reaches the page as a reload event');
});

test('actors with always: true run from boot, outside the toggle, and do not count as toggleable actors', async () => {
  let keeper = 0, trader = 0;
  const sim = await runScenario({ persist: false, clock: 1, actors: [
    { name: 'keeper', always: true, every: 15, run: () => { keeper++; } },
    { name: 'trader', every: 15, run: () => { trader++; } },
  ] });
  const rpc = (m, p = []) => sim.provider.request({ method: m, params: p });
  await until(() => keeper >= 2, 3000, 'the keeper running without the toggle'); assert.equal(trader, 0, 'the trader waits for the toggle');
  assert.equal((await rpc('terrarium_status')).hasActors, true);
  await rpc('terrarium_actors', [true]); await until(() => trader >= 1, 3000, 'the trader after the toggle');
  await rpc('terrarium_actors', [false]); const k = keeper; await until(() => keeper > k, 3000, 'the keeper after the toggle went off (the toggle never stops an always actor)');
  const only = await runScenario({ persist: false, clock: 1, actors: [{ always: true, every: 1000, run() {} }] });
  assert.equal((await only.provider.request({ method: 'terrarium_status' })).hasActors, false, 'nothing to toggle: the dev bar hides the button');
});

test('a list of scenarios: the first boots by default, terrarium_scenarios lists them, selecting stores the choice and reloads, each persists under its own slug, reset wipes only the active one', async () => {
  const storage = memoryStorage(), booted = [];
  const list = [
    { name: 'Fresh pond', description: 'as it opens', clock: 1, setup: () => { booted.push('fresh'); } },
    { name: 'After a whale dump', description: 'price crashed', clock: 1, setup: () => { booted.push('dump'); } },
    { name: 'Custom key', persist: 'mine', clock: 1, setup: () => { booted.push('custom'); } },
  ];
  posted.length = 0;
  const a = await runScenario(list, { storage });
  assert.deepEqual(booted, ['fresh']);
  const st = await a.provider.request({ method: 'terrarium_status' });
  assert.equal(st.scenario, 'Fresh pond');
  assert.deepEqual(await a.provider.request({ method: 'terrarium_scenarios' }), { active: 'Fresh pond', scenarios: [
    { name: 'Fresh pond', description: 'as it opens', persist: 'fresh-pond' }, { name: 'After a whale dump', description: 'price crashed', persist: 'after-a-whale-dump' }, { name: 'Custom key', description: null, persist: 'mine' }] });
  await a.provider.request({ method: 'evm_mine' }); await a.flush();
  assert.ok(await storage.getItem('fresh-pond'), 'persisted under the slug of its name');
  await assert.rejects(a.provider.request({ method: 'terrarium_selectScenario', params: ['Nope'] }), /no scenario named "Nope"/);
  assert.equal(await a.provider.request({ method: 'terrarium_selectScenario', params: ['Fresh pond'] }), 'Fresh pond', 'selecting the active one is a no-op');
  assert.equal(posted.filter((m) => m.event === 'reload').length, 0);
  assert.equal(await a.provider.request({ method: 'terrarium_selectScenario', params: ['After a whale dump'] }), 'After a whale dump');
  assert.equal(posted.filter((m) => m.event === 'reload').length, 1, 'the page reloads to boot the chosen one');
  assert.equal(await storage.getItem('terrarium:scenario'), 'After a whale dump');
  // the reload: the same list boots the stored choice, with its own chain
  const b = await runScenario(list, { storage });
  assert.deepEqual(booted, ['fresh', 'dump']);
  assert.equal((await b.provider.request({ method: 'terrarium_status' })).scenario, 'After a whale dump');
  assert.equal(b.blockNumber, 0n, 'its own chain, not the first scenario\'s mined block');
  await b.provider.request({ method: 'evm_mine' }); await b.flush();
  await b.provider.request({ method: 'terrarium_reset' });
  assert.equal(await storage.getItem('after-a-whale-dump'), null, 'reset removed this scenario\'s chain');
  assert.ok(await storage.getItem('fresh-pond'), 'and left the other one alone');
  assert.equal(await storage.getItem('terrarium:scenario'), 'After a whale dump', 'and the selection');
  a.stop(); b.stop();
});
