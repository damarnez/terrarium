// HTTP routes: the dapp's API and subgraph calls answered from the chain. The GraphQL parser, the Worker-side dispatch
// (terrarium_httpRoutes / terrarium_http through runScenario), and the page-side fetch interceptor with both ends of the
// bridge in one process.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseEther } from 'viem';
import { runScenario } from 'terrarium/worker';
import { createWorkerProvider, serveProvider } from 'terrarium/bridge';
import { compileMatcher, installHttpInterceptor, parseGraphql, reply } from 'terrarium/http';
import { PEPE } from './helpers.mjs';

const posted = [];
before(() => { globalThis.postMessage = (m) => posted.push(m); });

test('parseGraphql: fields, aliases, arguments (nested objects, lists, enums, variables with defaults), selections, operation choice', () => {
  const q = `
    # the Uniswap V2 subgraph query a frontend sends
    query Recent($pair: String!, $n: Int = 5) {
      swaps(first: $n, orderBy: timestamp, orderDirection: desc, where: { pair: $pair, amount0In_gt: "0" }) @live {
        id timestamp amount0In amount1Out to transaction { id blockNumber }
      }
      pool: pair(id: $pair) { reserve0 reserve1 txCount }
      bundles(where: { id_in: ["1", "2"] }, skip: 0) { ethPrice }
      ...PairFields
    }
    fragment PairFields on Query { token(id: "0x1") { symbol } }
    query Other { unused { x } }`;
  const fields = parseGraphql(q, { pair: '0xabc' });
  assert.deepEqual(fields.map((f) => [f.alias, f.field]), [['swaps', 'swaps'], ['pool', 'pair'], ['bundles', 'bundles']]);
  assert.deepEqual(fields[0].args, { first: 5, orderBy: 'timestamp', orderDirection: 'desc', where: { pair: '0xabc', amount0In_gt: '0' } });
  assert.deepEqual(fields[0].selection, ['id', 'timestamp', 'amount0In', 'amount1Out', 'to', 'transaction']);
  assert.deepEqual(fields[1].args, { id: '0xabc' }); assert.deepEqual(fields[1].selection, ['reserve0', 'reserve1', 'txCount']);
  assert.deepEqual(fields[2].args, { where: { id_in: ['1', '2'] }, skip: 0 });
  assert.equal(fields[0].operationName, 'Recent'); assert.deepEqual(fields[0].variables, { pair: '0xabc', n: 5 });
  assert.equal(parseGraphql(q, { pair: '0x1', n: 2 }, 'Other')[0].field, 'unused');
  assert.deepEqual(parseGraphql('{ a b(x: true, y: null, z: -1.5e3) }')[2 - 1].args, { x: true, y: null, z: -1500 });
  assert.throws(() => parseGraphql('{ a '), /unexpected end/);
  assert.throws(() => parseGraphql(q, {}, 'Nope'), /unknown operation/);
});

test('compileMatcher: prefix strings, globs, RegExp, method restriction', () => {
  const prefix = compileMatcher({ index: 0, match: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2' });
  assert.ok(prefix('https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2', 'POST')); assert.ok(prefix('https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2?x=1', 'GET'));
  assert.ok(!prefix('https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3', 'POST'));
  const glob = compileMatcher({ index: 0, match: 'https://api.coingecko.com/api/v3/simple/price*', method: 'GET' });
  assert.ok(glob('https://api.coingecko.com/api/v3/simple/price?ids=ethereum', 'get')); assert.ok(!glob('https://api.coingecko.com/api/v3/simple/price', 'POST'));
  const re = compileMatcher({ index: 0, match: { regex: '^https://[^/]+/v1/positions/0x[0-9a-f]{40}$', flags: 'i' } });
  assert.ok(re('https://backend.example/v1/positions/0x' + 'AB'.repeat(20), 'GET')); assert.ok(!re('https://backend.example/v1/positions/', 'GET'));
});

/** a scenario with three routes: a REST price API (handler), a subgraph (graphql resolvers over real logs), and a failing backend */
const scenario = (extra = {}) => ({
  persist: false, clock: 1_700_000_000, seed: 1,
  async setup(ctx) {
    const r = await ctx.wait(ctx.wallet(ctx.accounts[9]).deployContract({ abi: PEPE.abi, bytecode: PEPE.bytecode, args: [parseEther('1000')] }));
    ctx.state.pepe = r.contractAddress; ctx.state.indexer = 'ok';
    for (const to of ctx.accounts.slice(0, 3)) await ctx.wait(ctx.wallet(ctx.accounts[9]).writeContract({ address: ctx.state.pepe, abi: PEPE.abi, functionName: 'transfer', args: [to, parseEther('1')] }));
  },
  http: [
    { name: 'prices', match: 'https://api.coingecko.com/api/v3/simple/price*', method: 'GET', handler: async (ctx, req) => ({ [req.query.ids]: { usd: Number(await ctx.rpc('eth_blockNumber')) * 1000 }, chainId: ctx.chainId, ua: req.headers['x-client'] ?? null }) },
    { name: 'subgraph', match: 'https://api.thegraph.com/subgraphs/name/pepe', graphql: {
      transfers: async (ctx, q) => {
        if (ctx.state.indexer === 'down') throw new Error('indexer is catching up');
        const logs = await ctx.pub.getContractEvents({ address: ctx.state.pepe, abi: PEPE.abi, eventName: 'Transfer', fromBlock: 0n });
        return logs.filter((l) => !q.args.where?.to || l.args.to.toLowerCase() === q.args.where.to.toLowerCase()).slice(0, q.args.first ?? 100).map((l) => ({ id: `${l.transactionHash}-${l.logIndex}`, to: l.args.to, value: l.args.value, block: l.blockNumber }));
      },
      token: (ctx, q) => ({ id: q.args.id, symbol: 'PEPE', selected: q.selection }),
    } },
    { name: 'backend', match: /^https:\/\/backend\.example\//, handler: (ctx, req) => (req.method === 'POST' ? reply({ saved: req.json }, { status: 201, headers: { 'x-request-id': '42' } }) : reply('gone fishing', { status: 503 })) },
  ],
  methods: { terrarium_indexer: (ctx, mode) => { ctx.state.indexer = mode; return mode; } },
  ...extra,
});

test('Worker side: routes are announced before boot, terrarium_http runs handlers and graphql resolvers with ctx, errors become GraphQL errors, status counts hits', async () => {
  posted.length = 0;
  const sim = await runScenario(scenario());
  const rpc = (m, p = []) => sim.provider.request({ method: m, params: p });
  assert.equal(posted[0].event, 'httpRoutes', 'the page learns the routes first'); assert.equal(posted.at(-1).event, 'ready');
  const routes = await rpc('terrarium_httpRoutes');
  assert.deepEqual(routes.map((r) => [r.index, r.name, r.method, typeof r.match === 'string' ? r.match : r.match.regex]), [[0, 'prices', 'GET', 'https://api.coingecko.com/api/v3/simple/price*'], [1, 'subgraph', undefined, 'https://api.thegraph.com/subgraphs/name/pepe'], [2, 'backend', undefined, '^https:\\/\\/backend\\.example\\/']]);
  // a REST handler: query string, headers, ctx, JSON 200
  const price = await rpc('terrarium_http', [0, { url: 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', method: 'GET', headers: { 'x-client': 'frogpond' } }]);
  assert.equal(price.status, 200); assert.equal(price.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(price.body), { ethereum: { usd: 4000 }, chainId: 31337, ua: 'frogpond' });
  // graphql: resolvers per field, args with variables, bigints serialised as strings, aliases honoured
  const query = 'query T($to: String) { transfers(first: 2, where: { to: $to }) { id to value block } tok: token(id: "0x1") { symbol } }';
  const g = await rpc('terrarium_http', [1, { url: 'https://api.thegraph.com/subgraphs/name/pepe', method: 'POST', headers: {}, body: JSON.stringify({ query, variables: { to: sim.accounts[1].address } }) }]);
  const { data, errors } = JSON.parse(g.body);
  assert.equal(errors, undefined); assert.equal(data.transfers.length, 1); assert.equal(data.transfers[0].to, sim.accounts[1].address); assert.equal(data.transfers[0].value, parseEther('1').toString()); assert.equal(data.transfers[0].block, '3');
  assert.deepEqual(data.tok, { id: '0x1', symbol: 'PEPE', selected: ['symbol'] });
  const all = JSON.parse((await rpc('terrarium_http', [1, { url: 'https://api.thegraph.com/subgraphs/name/pepe', method: 'POST', body: JSON.stringify({ query: '{ transfers { id } }' }) }])).body);
  assert.equal(all.data.transfers.length, 4, 'without a where filter: every Transfer log on the chain (the mint + 3 transfers)');
  // GET with ?query=, an unknown field and a throwing resolver both become `errors`, like a real GraphQL server
  await rpc('terrarium_indexer', ['down']);
  const bad = JSON.parse((await rpc('terrarium_http', [1, { url: 'https://api.thegraph.com/subgraphs/name/pepe?query=' + encodeURIComponent('{ transfers { id } nope { x } }'), method: 'GET' }])).body);
  assert.deepEqual(bad.data, { transfers: null, nope: null }); assert.deepEqual(bad.errors.map((e) => e.message), ['indexer is catching up', 'Type "Query" has no field "nope"']);
  const syntax = await rpc('terrarium_http', [1, { url: 'https://api.thegraph.com/subgraphs/name/pepe', method: 'POST', body: JSON.stringify({ query: '{ transfers ' }) }]);
  assert.equal(syntax.status, 400); assert.match(JSON.parse(syntax.body).errors[0].message, /Syntax Error/);
  // reply(): explicit status, headers, text bodies; req.json for POST bodies
  const saved = await rpc('terrarium_http', [2, { url: 'https://backend.example/v1/notes', method: 'POST', body: JSON.stringify({ note: 'hi' }) }]);
  assert.equal(saved.status, 201); assert.equal(saved.headers['x-request-id'], '42'); assert.deepEqual(JSON.parse(saved.body), { saved: { note: 'hi' } });
  const down = await rpc('terrarium_http', [2, { url: 'https://backend.example/v1/notes', method: 'GET' }]);
  assert.equal(down.status, 503); assert.equal(down.headers['content-type'], 'text/plain'); assert.equal(down.body, 'gone fishing');
  const st = await rpc('terrarium_status');
  assert.deepEqual(st.http, { routes: 3, hits: 7 });
  await assert.rejects(rpc('terrarium_http', [9, { url: 'x', method: 'GET' }]), /no http route 9/);
});

test('page side: the patched fetch answers matching URLs from the Worker with a real Response, passes the rest through, and reports a broken handler as a 500', async () => {
  const sim = await runScenario(scenario({ http: [
    { match: 'https://api.example/v1/', handler: (ctx, req) => ({ path: new URL(req.url).pathname, method: req.method, body: req.json, block: Number(ctx.sim.blockNumber) }) },
    { match: 'https://api.example/boom', handler: () => { throw new Error('handler bug'); } },
  ] }));
  // both ends of the bridge in this process (as bridge.test does), and a fake network for everything else
  const worker = { onmessage: null, postMessage: (req) => setTimeout(() => globalThis.onmessage({ data: req }), 0) };
  globalThis.postMessage = (res) => worker.onmessage?.({ data: res });
  const provider = createWorkerProvider(worker);
  const routes = provider.request({ method: 'terrarium_httpRoutes' });
  serveProvider(sim.provider);
  const scope = { fetch: async (input, init) => new Response(`network: ${input instanceof Request ? input.url : input} ${init?.method ?? 'GET'}`) };
  const restore = installHttpInterceptor(provider, routes, scope);
  const warn = console.warn; const warned = []; console.warn = (...a) => warned.push(a.join(' '));
  try {
    const r = await scope.fetch('https://api.example/v1/positions?user=me', { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } });
    assert.ok(r instanceof Response); assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/json');
    assert.deepEqual(await r.json(), { path: '/v1/positions', method: 'POST', body: { a: 1 }, block: 4 });
    const asRequest = await scope.fetch(new Request('https://api.example/v1/x', { method: 'PUT', body: 'raw' }));
    assert.equal((await asRequest.json()).method, 'PUT');
    assert.equal(await (await scope.fetch('https://elsewhere.example/thing')).text(), 'network: https://elsewhere.example/thing GET', 'unmatched: the real fetch, untouched');
    const boom = await scope.fetch('https://api.example/boom');
    assert.equal(boom.status, 500); assert.match((await boom.json()).error, /handler bug/); assert.match(warned[0], /http route 1 failed/);
    restore();
    assert.match(await (await scope.fetch('https://api.example/v1/positions')).text(), /^network:/);
  } finally { console.warn = warn; }
});
