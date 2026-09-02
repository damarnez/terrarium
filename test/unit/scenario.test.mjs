// The scenario runtime (what the Worker runs) driven in Node: setup context, actors, status, controls, methods,
// the recording clock, fork status, reset. Worker globals are shimmed; persistence is off (IndexedDB is browser-only,
// the e2e covers the reload path).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keccak256, parseEther, toHex } from 'viem';
import { runScenario } from 'terrarium/worker';
import { PEPE, FIXTURE, sleep } from './helpers.mjs';

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
    await sleep(60); assert.ok(ticks >= 2); assert.ok(failures >= 1, 'a throwing actor is logged, not fatal');
    await rpc('eth_sendTransaction', [{ from: sim.accounts[9].address, to: pepeAddr(sim), data: '0xa9059cbb' + sim.accounts[1].address.slice(2).padStart(64, '0') + (1n).toString(16).padStart(64, '0') }]);
    await sleep(5);
    assert.equal(reactions.length, 1);
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
