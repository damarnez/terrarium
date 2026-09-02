#!/usr/bin/env node
// terrarium — the CLI.
//
//   terrarium build [--scenario terrarium.scenario.ts] [--out dist-terrarium]
//       One injectable classic script (dist-terrarium/terrarium.js): chain Worker + wallet + dev bar. Inject it into
//       any page (Playwright addInitScript, a <script> tag, a bookmarklet) — your dapp built without the Terrarium,
//       a Storybook, someone else's dapp.
//
//   terrarium fetch-code <name=0xaddress>... --rpc <url> [--out fixture.json]
//       Runtime bytecode of deployed contracts as a fixture for ctx.install() — the real protocol, byte for byte.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const [cmd, ...rest] = process.argv.slice(2);
const args = {}; const positional = [];
for (let i = 0; i < rest.length; i++) { if (rest[i].startsWith('--')) args[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? true : rest[++i]; else positional.push(rest[i]); }
const define = { 'process.env.DEBUG': 'undefined', 'process.env.TERRARIUM_DEBUG': 'undefined' };

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
  if (!args.rpc || positional.length === 0) { console.error('usage: terrarium fetch-code <name=0xaddress>... --rpc <url> [--out fixture.json]'); process.exit(1); }
  const rpc = async (method, params) => { const r = await (await fetch(args.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw new Error(r.error.message); return r.result; };
  const blockNumber = Number(await rpc('eth_blockNumber', []));
  const contracts = {};
  for (const spec of positional) {
    const [name, address] = spec.split('=');
    const code = await rpc('eth_getCode', [address, 'latest']);
    if (code === '0x') { console.error(`${name}: no code at ${address}`); process.exit(1); }
    contracts[name] = { address, code };
    console.log(`${name.padEnd(12)} ${address} ${(code.length - 2) / 2} bytes`);
  }
  const fixture = { source: `runtime bytecode fetched with \`terrarium fetch-code\` via ${args.rpc}`, blockNumber, fetchedAt: new Date().toISOString(), contracts };
  const out = args.out ?? 'fixture.json';
  writeFileSync(out, JSON.stringify(fixture, null, 2));
  console.log(`wrote ${out}`);
} else {
  console.log('usage:\n  terrarium build [--scenario terrarium.scenario.ts] [--out dist-terrarium]\n  terrarium fetch-code <name=0xaddress>... --rpc <url> [--out fixture.json]');
  process.exit(cmd ? 1 : 0);
}
