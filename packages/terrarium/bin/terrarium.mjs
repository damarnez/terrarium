#!/usr/bin/env node
// terrarium — the CLI.
//
//   terrarium build [--scenario terrarium.scenario.ts] [--out dist-terrarium]
//       One injectable classic script (dist-terrarium/terrarium.js): chain Worker + wallet + dev bar. Inject it into
//       any page (Playwright addInitScript, a <script> tag, a bookmarklet) — your dapp built without the Terrarium,
//       a Storybook, someone else's dapp.
//
//   terrarium fetch-code <name=0xaddress>... --rpc <url> [--block N] [--chain ID] [--out fixture.json]
//       Runtime bytecode of deployed contracts as a fixture for ctx.install() — the real protocol, byte for byte,
//       at a specific block if you ask for one.
//
//   terrarium record [name=0xaddress]... --rpc <url> [--block N] [--chain ID] [--storage name:slot,slot] [--script warm.mjs] [--keep] [--out fixture.json]
//       The STATE of a chain at a block, as an offline fork fixture: forks the chain at --block, reads every named
//       account (balance, nonce, code) and storage slot, runs your script against the fork (every account, code blob
//       and slot the EVM touches is recorded), rolls the script's changes back (unless --keep) and dumps. The fixture
//       is what a scenario's `fork: { blockNumber, offline: true }, restore: fixture.dump` consumes.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [cmd, ...rest] = process.argv.slice(2);
const args = {}; const positional = [];
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith('--')) { positional.push(rest[i]); continue; }
  const key = rest[i].slice(2), value = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i];
  args[key] = key in args ? [].concat(args[key], value) : value;      // a repeated flag collects (--storage a:1 --storage b:2)
}
const define = { 'process.env.DEBUG': 'undefined', 'process.env.TERRARIUM_DEBUG': 'undefined' };
const usage = `usage:
  terrarium build [--scenario terrarium.scenario.ts] [--out dist-terrarium]
  terrarium fetch-code <name=0xaddress>... --rpc <url> [--block N] [--chain ID] [--out fixture.json]
  terrarium record [name=0xaddress]... --rpc <url> [--block N] [--chain ID] [--storage name:slot,slot] [--script warm.mjs] [--keep] [--out fixture.json]`;
const fail = (msg) => { console.error(msg); process.exit(1); };
const hex = (n) => '0x' + BigInt(n).toString(16);
/** a raw JSON-RPC call to --rpc */
const remote = async (method, params = []) => {
  const r = await (await fetch(args.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
  if (r.error) throw new Error(`${method}: ${r.error.message}`); return r.result;
};
/** name=0xaddress pairs → { name: address }; a bare 0xaddress is its own name */
const parseAddresses = (specs) => Object.fromEntries(specs.map((spec) => { const [name, address = name] = spec.split('='); if (!/^0x[0-9a-fA-F]{40}$/.test(address)) fail(`${spec}: expected name=0xaddress`); return [name, address]; }));
/** the chain the node serves, checked against --chain when given */
const resolveChain = async () => {
  const chainId = Number(await remote('eth_chainId'));
  if (args.chain !== undefined && Number(args.chain) !== chainId) fail(`--chain ${args.chain} but ${args.rpc} serves chain ${chainId}`);
  return chainId;
};

if (cmd === 'build') {
  const { build } = await import('vite');
  const root = process.cwd(), out = args.out ?? 'dist-terrarium';
  const scenario = '/' + relative(root, resolve(root, args.scenario ?? 'terrarium.scenario.ts')).split(sep).join('/');
  const dir = resolve(root, '.terrarium'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'worker.ts'), `import scenario from '${scenario}';\nimport { runScenario } from 'terrarium/worker';\nrunScenario(scenario);\n`);
  writeFileSync(join(dir, 'inject-bundle.ts'), `import { startTerrarium } from 'terrarium/inject';\ndeclare const __TERRARIUM_WORKER_SRC__: string;\nstartTerrarium(new Worker(URL.createObjectURL(new Blob([__TERRARIUM_WORKER_SRC__], { type: 'text/javascript' })), { type: 'module' }));\n`);
  await build({ root, configFile: false, logLevel: 'warn', define, build: { outDir: out, emptyOutDir: true, target: 'es2022', minify: true, lib: { entry: '.terrarium/worker.ts', formats: ['es'], fileName: () => 'terrarium.worker.js' }, rollupOptions: { output: { codeSplitting: false } } } });
  const outDir = resolve(root, out);
  const workerSrc = readFileSync(join(outDir, 'terrarium.worker.js'), 'utf8');
  await build({ root, configFile: false, logLevel: 'warn', define: { ...define, __TERRARIUM_WORKER_SRC__: JSON.stringify(workerSrc) }, build: { outDir: out, emptyOutDir: false, target: 'es2022', minify: true, lib: { entry: '.terrarium/inject-bundle.ts', formats: ['iife'], name: 'Terrarium', fileName: () => 'terrarium.js' } } });
  for (const f of ['terrarium.worker.js', 'terrarium.js']) console.log(`${out}/${f}: ${(statSync(join(outDir, f)).size / 1024).toFixed(0)} KB`);
} else if (cmd === 'fetch-code') {
  if (!args.rpc || positional.length === 0) fail(usage);
  const chainId = await resolveChain();
  const blockNumber = args.block !== undefined ? Number(args.block) : Number(await remote('eth_blockNumber'));
  const contracts = {};
  for (const [name, address] of Object.entries(parseAddresses(positional))) {
    const code = await remote('eth_getCode', [address, hex(blockNumber)]);
    if (code === '0x') fail(`${name}: no code at ${address} (chain ${chainId}, block ${blockNumber})`);
    contracts[name] = { address, code };
    console.log(`${name.padEnd(12)} ${address} ${(code.length - 2) / 2} bytes`);
  }
  const fixture = { source: `runtime bytecode fetched with \`terrarium fetch-code\` via ${args.rpc}`, chainId, blockNumber, fetchedAt: new Date().toISOString(), contracts };
  const out = args.out ?? 'fixture.json';
  writeFileSync(out, JSON.stringify(fixture, null, 2));
  console.log(`wrote ${out} (chain ${chainId}, block ${blockNumber})`);
} else if (cmd === 'record') {
  if (!args.rpc) fail(usage);
  const [{ createTerrarium }, viem] = await Promise.all([import('../src/engine.js'), import('viem')]);
  const chainId = await resolveChain();
  // a few blocks back by default: past any reorg, still within a non-archive node's recent state
  const blockNumber = args.block !== undefined ? Number(args.block) : Number(await remote('eth_blockNumber')) - 8;
  const header = await remote('eth_getBlockByNumber', [hex(blockNumber), false]).catch(() => null);
  if (header === null) fail(`block ${blockNumber} is not available from ${args.rpc} (an archive node serves old blocks; a full node only the last ~128)`);
  const addresses = parseAddresses(positional);
  // the chain's clock continues from the recorded block, so time-dependent contracts (oracles, interest) see a consistent "now"
  const anchor = Number(BigInt(header.timestamp)) + 12, t0 = Date.now();
  console.log(`forking chain ${chainId} at block ${blockNumber} via ${args.rpc}`);
  const sim = await createTerrarium({ chainId, fork: { url: args.rpc, blockNumber }, seed: 1, clock: () => anchor + Math.floor((Date.now() - t0) / 1000) });
  const rpc = (method, params = []) => sim.provider.request({ method, params });
  const chain = viem.defineChain({ id: chainId, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
  const pub = viem.createPublicClient({ chain, transport: viem.custom(sim.provider), pollingInterval: 20 });
  const accounts = sim.accounts.map((a) => a.address);
  const wallet = (account = accounts[0]) => viem.createWalletClient({ chain, transport: viem.custom(sim.provider), account });
  // ---- 1. every named account: balance, nonce, code ----
  for (const [name, address] of Object.entries(addresses)) {
    const [balance, nonce, code] = await Promise.all([rpc('eth_getBalance', [address, 'latest']), rpc('eth_getTransactionCount', [address, 'latest']), rpc('eth_getCode', [address, 'latest'])]);
    console.log(`  ${name.padEnd(12)} ${address} ${viem.formatEther(BigInt(balance))} ETH, nonce ${Number(nonce)}, ${(code.length - 2) / 2} bytes of code`);
  }
  // ---- 2. explicit storage slots: --storage name:0x0,0x1 (name from the list above, or an address) ----
  for (const spec of [].concat(args.storage ?? [])) {
    const [who, slots = ''] = spec.split(':'); const address = addresses[who] ?? who;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) fail(`--storage ${spec}: unknown name or address`);
    for (const slot of slots.split(',').filter(Boolean)) await rpc('eth_getStorageAt', [address, hex(slot), 'latest']);
    console.log(`  ${who}: slots ${slots}`);
  }
  // ---- 3. your script: reads and transactions against the fork (recorded), rolled back unless --keep ----
  let expected;
  if (args.script) {
    const mod = await import(pathToFileURL(resolve(process.cwd(), args.script)).href);
    const run = mod.default ?? mod.record; if (typeof run !== 'function') fail(`${args.script}: export a default async function ({ sim, pub, wallet, accounts, addresses, rpc })`);
    const clean = args.keep ? null : await sim.snapshot();
    console.log(`running ${args.script}:`);
    expected = await run({ sim, pub, wallet, accounts, addresses, rpc, viem });
    if (clean !== null) await sim.revert(clean);
  }
  // ---- 4. dump ----
  const dump = await sim.dumpState();
  const remoteReads = { accounts: Object.keys(dump.remote.accounts).length, code: Object.keys(dump.remote.code).length, storage: Object.keys(dump.remote.storage).length };
  const fixture = { source: `chain ${chainId} state at block ${blockNumber}, recorded with \`terrarium record\` via ${args.rpc}`, chainId, blockNumber, timestamp: Number(BigInt(header.timestamp)), recordedAt: new Date().toISOString(), addresses, expected: expected ?? undefined, remoteReads, dump };
  const out = args.out ?? 'fixture.json';
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(fixture, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  // ---- 5. prove the fixture replays with the network unplugged ----
  const realFetch = globalThis.fetch; globalThis.fetch = async (url) => { throw new Error(`offline: ${url}`); };
  try {
    const replay = await createTerrarium({ chainId, fork: { blockNumber, offline: true }, restore: JSON.parse(readFileSync(out, 'utf8')).dump, seed: 1, clock: () => anchor });
    for (const address of Object.values(addresses)) await replay.provider.request({ method: 'eth_getCode', params: [address, 'latest'] });
    if (replay.offlineMisses.length) fail(`offline replay missed: ${replay.offlineMisses.map((m) => `${m.kind} ${m.key}`).join(', ')}`);
  } finally { globalThis.fetch = realFetch; }
  console.log(`recorded ${remoteReads.accounts} accounts, ${remoteReads.code} code blobs, ${remoteReads.storage} slots (${(statSync(out).size / 1024).toFixed(0)} KB) -> ${out}; offline replay OK`);
} else {
  console.log(usage);
  process.exit(cmd ? 1 : 0);
}
