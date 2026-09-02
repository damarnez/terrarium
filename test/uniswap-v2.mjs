// test/uniswap-v2.mjs — the REAL Uniswap V2 (mainnet runtime bytecode of Factory, Router02 and WETH9, installed at
// their mainnet addresses) running inside the Terrarium, differential-tested against Anvil.
//
// The same scenario runs on both chains with the same keys, nonces, gas limits, fee caps and block timestamps, so
// every transaction hash, contract address, receipt, log and revert payload must come out byte-identical. If the
// in-browser EVM evaluated state differently from a reference node, this is where it would show.
//
//   npm run test:uniswap
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, custom, http, defineChain, parseAbi, parseEther, decodeErrorResult, encodeFunctionData, encodeDeployData, keccak256, maxUint256, numberToHex, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createTerrarium, TEST_KEYS } from 'terrarium/engine';
import { createBlockHeaderFromRPC, genTransactionsTrieRoot } from '@ethereumjs/block';
import { createTxFromRPC } from '@ethereumjs/tx';
import { encodeReceipt, Bloom } from '@ethereumjs/vm';
import { MerklePatriciaTrie } from '@ethereumjs/mpt';
import { RLP } from '@ethereumjs/rlp';
import { Common, Hardfork, Mainnet } from '@ethereumjs/common';
import { bytesToHex, hexToBytes } from '@ethereumjs/util';

const fixture = JSON.parse(readFileSync(new URL(import.meta.resolve('terrarium/fixtures/uniswap-v2-mainnet.json')), 'utf8'));
const PEPE = JSON.parse(readFileSync(new URL('../contracts/out/PEPE.json', import.meta.url), 'utf8'));
const FACTORY = fixture.contracts.factory.address, ROUTER = fixture.contracts.router.address, WETH = fixture.contracts.weth.address;

const routerAbi = parseAbi([
  'function WETH() view returns (address)',
  'function factory() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)',
  'function removeLiquidityETH(address token, uint256 liquidity, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) returns (uint256 amountToken, uint256 amountETH)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);
const factoryAbi = parseAbi(['function getPair(address, address) view returns (address)', 'function allPairsLength() view returns (uint256)']);
const pairAbi = parseAbi(['function getReserves() view returns (uint112, uint112, uint32)', 'function token0() view returns (address)', 'function token1() view returns (address)', 'function totalSupply() view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function approve(address, uint256) returns (bool)']);
const erc20Abi = parseAbi(['function approve(address, uint256) returns (bool)', 'function transfer(address, uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address, address) view returns (uint256)']);
const errorStringAbi = parseAbi(['error Error(string)']);

const chain = defineChain({ id: 31337, name: 'local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
// identical on both chains -> identical signed bytes -> identical tx hashes
const FEES = { gas: 3_000_000n, maxFeePerGas: 10n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n };
const START_TS = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

/** Uniswap V2 getAmountOut, written independently of any contract: the number the EVM has to agree with. */
const v2AmountOut = (amountIn, reserveIn, reserveOut) => (amountIn * 997n * reserveOut) / (reserveIn * 1000n + amountIn * 997n);

async function runScenario(raw, transport) {
  const pub = createPublicClient({ chain, transport, pollingInterval: 20 });
  const wallets = TEST_KEYS.map((k) => createWalletClient({ chain, transport, account: privateKeyToAccount(k) }));
  const addr = wallets.map((w) => w.account.address);
  const [user, noApproval, noFunds, , , , , , , treasury] = addr;
  const out = { steps: [], calls: {}, reverts: {} }, estimates = {};
  let ts = START_TS;
  const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

  /** one tx: pin the block timestamp (so both chains agree), estimate (informational), send, record the receipt */
  const timing = process.env.TERRARIUM_TIMING ? [] : null;
  const send = async (label, w, req) => {
    const t = [Date.now()];
    ts += 12n; await raw('evm_setNextBlockTimestamp', [Number(ts)]); t.push(Date.now());
    let hash, est;
    if (req.deploy) { est = await pub.estimateGas({ account: w.account, data: encodeDeployData(req.deploy) }).catch(() => 'reverts'); t.push(Date.now()); hash = await w.deployContract({ ...req.deploy, ...FEES }); }
    else { est = await pub.estimateContractGas({ ...req, account: w.account }).catch(() => 'reverts'); t.push(Date.now()); hash = await w.writeContract({ ...req, ...FEES }); }
    t.push(Date.now());
    const r = await pub.waitForTransactionReceipt({ hash }); t.push(Date.now());
    if (timing) timing.push(`  ${label.padEnd(48)} setTs ${String(t[1] - t[0]).padStart(4)}  estimate ${String(t[2] - t[1]).padStart(5)}  send ${String(t[3] - t[2]).padStart(5)}  receipt ${String(t[4] - t[3]).padStart(5)}`);
    out.steps.push({ label, hash, status: r.status, gasUsed: r.gasUsed, contractAddress: r.contractAddress ?? null, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) });
    estimates[label] = est;
    return r;
  };
  /** what a dapp sees when it simulates a call that reverts: the raw revert payload + the decoded reason */
  const revertOf = async (label, from, req, value = 0n) => {
    try { await raw('eth_call', [{ from, to: req.address, data: encodeFunctionData(req), value: numberToHex(value) }, 'latest']); out.reverts[label] = null; }
    catch (e) { const data = e.data ?? e.cause?.data ?? null; let reason = null; try { reason = decodeErrorResult({ abi: errorStringAbi, data }).args[0]; } catch { /* not Error(string) */ } out.reverts[label] = { data, reason }; }
  };
  const deadline = () => ts + 3600n;

  // 0. install the real Uniswap V2 at its mainnet addresses (EVM state, via the RPC layer -> journaled)
  for (const c of Object.values(fixture.contracts)) await raw('anvil_setCode', [c.address, c.code]);
  out.calls.codeInstalledByteIdentical = (await Promise.all(Object.values(fixture.contracts).map(async (c) => (await raw('eth_getCode', [c.address, 'latest'])) === c.code))).every(Boolean);
  out.calls.routerKnowsWETH = await read(ROUTER, routerAbi, 'WETH');
  out.calls.routerKnowsFactory = await read(ROUTER, routerAbi, 'factory');

  // 1. PEPE + the pool (the factory creates the pair from its embedded creation code)
  const pepe = (await send('deploy PEPE', wallets[9], { deploy: { abi: PEPE.abi, bytecode: PEPE.bytecode, args: [parseEther('420690000000')] } })).contractAddress;
  await send('treasury approves router', wallets[9], { address: pepe, abi: erc20Abi, functionName: 'approve', args: [ROUTER, maxUint256] });
  await send('treasury addLiquidityETH 10 ETH + 8M PEPE', wallets[9], { address: ROUTER, abi: routerAbi, functionName: 'addLiquidityETH', args: [pepe, parseEther('8000000'), parseEther('8000000'), parseEther('10'), treasury, deadline()], value: parseEther('10') });
  const pair = await read(FACTORY, factoryAbi, 'getPair', [pepe, WETH]);
  out.calls.pair = pair;
  out.calls.pairCodeHash = keccak256(await raw('eth_getCode', [pair, 'latest']));
  out.calls.pairTokens = [await read(pair, pairAbi, 'token0'), await read(pair, pairAbi, 'token1')];
  out.calls.reservesAfterSeed = await read(pair, pairAbi, 'getReserves');
  out.calls.treasuryLP = await read(pair, pairAbi, 'balanceOf', [treasury]);
  await send('treasury sends user 50M PEPE', wallets[9], { address: pepe, abi: erc20Abi, functionName: 'transfer', args: [user, parseEther('50000000')] });
  await send('treasury sends noApproval 1M PEPE', wallets[9], { address: pepe, abi: erc20Abi, functionName: 'transfer', args: [noApproval, parseEther('1000000')] });

  // 2. swap ETH -> PEPE through the router; the router's quote, the EVM's execution and an independent formula must agree
  const [r0, r1] = await read(pair, pairAbi, 'getReserves');
  const [reserveETH, reservePEPE] = out.calls.pairTokens[0].toLowerCase() === WETH.toLowerCase() ? [r0, r1] : [r1, r0];
  const quote = await read(ROUTER, routerAbi, 'getAmountsOut', [parseEther('1'), [WETH, pepe]]);
  const before = await read(pepe, erc20Abi, 'balanceOf', [user]);
  await send('user swapExactETHForTokens 1 ETH', wallets[0], { address: ROUTER, abi: routerAbi, functionName: 'swapExactETHForTokens', args: [0n, [WETH, pepe], user, deadline()], value: parseEther('1') });
  const received = (await read(pepe, erc20Abi, 'balanceOf', [user])) - before;
  out.calls.swap1 = { routerQuote: quote[1], independentFormula: v2AmountOut(parseEther('1'), reserveETH, reservePEPE), actuallyReceived: received };
  out.calls.swap1.allAgree = quote[1] === received && received === out.calls.swap1.independentFormula;

  // 3. the approval, and swapping PEPE -> ETH
  out.calls.allowanceBeforeApprove = await read(pepe, erc20Abi, 'allowance', [user, ROUTER]);
  await send('user approves router', wallets[0], { address: pepe, abi: erc20Abi, functionName: 'approve', args: [ROUTER, maxUint256] });
  out.calls.allowanceAfterApprove = await read(pepe, erc20Abi, 'allowance', [user, ROUTER]);
  await send('user swapExactTokensForETH 200k PEPE', wallets[0], { address: ROUTER, abi: routerAbi, functionName: 'swapExactTokensForETH', args: [parseEther('200000'), 0n, [pepe, WETH], user, deadline()] });

  // 4. add + remove liquidity as the user
  await send('user addLiquidityETH 2 ETH', wallets[0], { address: ROUTER, abi: routerAbi, functionName: 'addLiquidityETH', args: [pepe, parseEther('5000000'), 0n, 0n, user, deadline()], value: parseEther('2') });
  const lp = await read(pair, pairAbi, 'balanceOf', [user]);
  out.calls.userLP = lp;
  await send('user approves pair LP', wallets[0], { address: pair, abi: pairAbi, functionName: 'approve', args: [ROUTER, lp] });
  await send('user removeLiquidityETH half', wallets[0], { address: ROUTER, abi: routerAbi, functionName: 'removeLiquidityETH', args: [pepe, lp / 2n, 0n, 0n, user, deadline()] });
  out.calls.userLPAfterRemove = await read(pair, pairAbi, 'balanceOf', [user]);
  out.calls.reservesAtEnd = await read(pair, pairAbi, 'getReserves');
  out.calls.totalSupplyAtEnd = await read(pair, pairAbi, 'totalSupply');

  // 5. the failure cases: what does the router say when...
  const sellReq = (who) => ({ address: ROUTER, abi: routerAbi, functionName: 'swapExactTokensForETH', args: [parseEther('100000'), 0n, [pepe, WETH], who, deadline()] });
  await revertOf('no approval', noApproval, sellReq(noApproval));                                // has PEPE, never approved
  await send('noFunds approves router', wallets[2], { address: pepe, abi: erc20Abi, functionName: 'approve', args: [ROUTER, maxUint256] });
  await revertOf('no funds', noFunds, sellReq(noFunds));                                          // approved, balance 0
  await revertOf('slippage', user, { address: ROUTER, abi: routerAbi, functionName: 'swapExactETHForTokens', args: [parseEther('1000000000'), [WETH, pepe], user, deadline()] }, parseEther('1'));
  await revertOf('expired', user, { address: ROUTER, abi: routerAbi, functionName: 'swapExactETHForTokens', args: [0n, [WETH, pepe], user, 1n] }, parseEther('1'));
  // ...and when the failing tx is actually sent (a wallet that skips simulation): a mined, reverted receipt
  await send('no approval, sent anyway (reverts on-chain)', wallets[1], sellReq(noApproval));
  await send('slippage, sent anyway (reverts on-chain)', wallets[0], { address: ROUTER, abi: routerAbi, functionName: 'swapExactETHForTokens', args: [parseEther('1000000000'), [WETH, pepe], user, deadline()], value: parseEther('1') });
  if (timing) console.log(timing.join('\n'));
  return { out, estimates };
}

// ---- RPC parity: the same questions to both nodes, normalised, compared -----------------------------------------
// Values that legitimately differ between two independent nodes (block hashes, base fee decay, timestamps of empty
// blocks) are reduced to their shape; everything else must match exactly.
async function rpcParity(rawA, rawB, ctx) {
  const norm = { block: (b) => b && { number: b.number, gasUsed: b.gasUsed, timestamp: b.timestamp, txs: b.transactions.length, hasHash: /^0x[0-9a-f]{64}$/.test(b.hash), keys: Object.keys(b).sort() },
    tx: (t) => t && { hash: t.hash, from: t.from.toLowerCase(), to: t.to?.toLowerCase() ?? null, input: t.input, value: t.value, nonce: t.nonce, type: t.type, blockNumber: t.blockNumber },
    receipt: (r) => r && { status: r.status, gasUsed: r.gasUsed, cumulativeGasUsed: r.cumulativeGasUsed, transactionIndex: r.transactionIndex, blockNumber: r.blockNumber, contractAddress: r.contractAddress?.toLowerCase() ?? null, logs: r.logs.map((l) => [l.address.toLowerCase(), l.topics, l.data, l.logIndex]) },
    logs: (ls) => ls.map((l) => [l.address.toLowerCase(), l.topics, l.data, l.blockNumber, l.transactionHash, l.logIndex]),
    feeHistory: (f) => ({ keys: Object.keys(f).sort(), n: f.baseFeePerGas.length, rewards: f.reward?.length }),
    hexNumber: (h) => /^0x[0-9a-f]+$/.test(h), same: (x) => x, lower: (x) => String(x).toLowerCase(), addrs: (xs) => xs.map((x) => x.toLowerCase()), len: (xs) => xs.length };
  const checks = [
    ['eth_chainId', [], 'same'], ['net_version', [], 'same'], ['eth_syncing', [], 'same'], ['eth_blockNumber', [], 'same'], ['eth_accounts', [], 'addrs'],
    ['eth_getBalance', [ctx.pair, 'latest'], 'same'], ['eth_getTransactionCount', [ctx.user, 'latest'], 'same'], ['eth_getCode', [ctx.pair, 'latest'], 'same'],
    ['eth_getStorageAt', [ctx.pair, '0x8', 'latest'], 'same'],                                       // reserve0|reserve1|blockTimestampLast
    ['eth_call', [{ to: ctx.pair, data: '0x0902f1ac' }, 'latest'], 'same'],                          // getReserves()
    ['eth_getBlockByNumber', ['latest', false], 'block'], ['eth_getBlockByNumber', ['0x1', true], 'block'], ['eth_getBlockByNumber', ['0x0', false], 'block'],
    ['eth_getTransactionByHash', [ctx.txHash], 'tx'], ['eth_getTransactionReceipt', [ctx.txHash], 'receipt'], ['eth_getTransactionReceipt', ['0x' + 'ab'.repeat(32)], 'same'],
    ['eth_getLogs', [{ address: ctx.pair, fromBlock: '0x0', toBlock: 'latest' }], 'logs'],
    ['eth_getLogs', [{ address: ctx.pair, fromBlock: '0x0', toBlock: 'latest', topics: [ctx.swapTopic] }], 'logs'],
    ['eth_gasPrice', [], 'hexNumber'], ['eth_maxPriorityFeePerGas', [], 'hexNumber'], ['eth_feeHistory', ['0x4', 'latest', [50]], 'feeHistory'],
    ['eth_estimateGas', [{ from: ctx.user, to: ctx.pair, data: '0x0902f1ac' }], 'hexNumber'],
  ];
  const rows = [];
  for (const [method, params, n] of checks) {
    const [ra, rb] = await Promise.all([rawA(method, params).then((r) => ({ r }), (e) => ({ e: e.code })), rawB(method, params).then((r) => ({ r }), (e) => ({ e: e.code }))]);
    const va = 'e' in ra ? { error: ra.e } : norm[n](ra.r), vb = 'e' in rb ? { error: rb.e } : norm[n](rb.r);
    rows.push({ method, params: JSON.stringify(params).slice(0, 60), ok: j(va) === j(vb), terrarium: va, anvil: vb });
  }
  // filters: install, mine an empty block, poll — same (empty) log deltas and one new block hash each
  const [fa, fb] = await Promise.all([rawA('eth_newFilter', [{ address: ctx.pair }]), rawB('eth_newFilter', [{ address: ctx.pair }])]);
  const [ba, bb] = await Promise.all([rawA('eth_newBlockFilter', []), rawB('eth_newBlockFilter', [])]);
  await Promise.all([rawA('evm_mine', []), rawB('evm_mine', [])]);
  const [ca, cb, ha, hb] = await Promise.all([rawA('eth_getFilterChanges', [fa]), rawB('eth_getFilterChanges', [fb]), rawA('eth_getFilterChanges', [ba]), rawB('eth_getFilterChanges', [bb])]);
  rows.push({ method: 'eth_newFilter + evm_mine + eth_getFilterChanges', params: '', ok: j(norm.logs(ca)) === j(norm.logs(cb)), terrarium: ca.length, anvil: cb.length });
  rows.push({ method: 'eth_newBlockFilter + evm_mine + eth_getFilterChanges', params: '', ok: ha.length === 1 && hb.length === 1, terrarium: ha.length, anvil: hb.length });
  rows.push({ method: 'eth_uninstallFilter', params: '', ok: (await rawA('eth_uninstallFilter', [fa])) === (await rawB('eth_uninstallFilter', [fb])), terrarium: true, anvil: true });
  // a revert through eth_call must carry the same error code and the same revert data
  const bad = { from: ctx.user, to: ctx.router, data: ctx.expiredCall };
  const [ea, eb] = await Promise.all([rawA('eth_call', [bad, 'latest']).then(() => null, (e) => ({ code: e.code, data: e.data })), rawB('eth_call', [bad, 'latest']).then(() => null, (e) => ({ code: e.code, data: e.data }))]);
  rows.push({ method: 'eth_call (reverting) -> error code + data', params: '', ok: j(ea) === j(eb), terrarium: ea, anvil: eb });
  return rows;
}

// ---- verifiable blocks: recompute every header hash, transactions root, receipts root and bloom from RPC output ----
// A node's word is not taken for any of them. The same verifier runs against Anvil, which proves the verifier.
async function verifyBlocks(raw) {
  const common = new Common({ chain: { ...Mainnet, chainId: 31337, name: 'verify' }, hardfork: Hardfork.Cancun });
  const latest = Number(await raw('eth_blockNumber', []));
  const out = { blocks: latest + 1, headerHash: 0, txRoot: 0, receiptsRoot: 0, bloom: 0, stateRootNonZero: 0 };
  for (let n = 0; n <= latest; n++) {
    const b = await raw('eth_getBlockByNumber', [numberToHex(n), true]);
    const header = createBlockHeaderFromRPC(b, { common, skipConsensusFormatValidation: true });
    if (bytesToHex(header.hash()) === b.hash) out.headerHash++;
    const txs = await Promise.all(b.transactions.map((t) => createTxFromRPC(t, { common })));
    if (bytesToHex(await genTransactionsTrieRoot(txs)) === b.transactionsRoot) out.txRoot++;
    const receipts = await Promise.all(b.transactions.map((t) => raw('eth_getTransactionReceipt', [t.hash])));
    const trie = new MerklePatriciaTrie(); const bloom = new Bloom(undefined, common);
    for (const [i, r] of receipts.entries()) {
      await trie.put(RLP.encode(i), encodeReceipt({ status: Number(r.status), cumulativeBlockGasUsed: BigInt(r.cumulativeGasUsed), bitvector: hexToBytes(r.logsBloom), logs: r.logs.map((l) => [hexToBytes(l.address), l.topics.map(hexToBytes), hexToBytes(l.data)]) }, Number(r.type)));
      bloom.or(new Bloom(hexToBytes(r.logsBloom), common));
    }
    if (bytesToHex(trie.root()) === b.receiptsRoot) out.receiptsRoot++;
    if (bytesToHex(bloom.bitvector) === b.logsBloom) out.bloom++;
    if (!/^0x0+$/.test(b.stateRoot)) out.stateRootNonZero++;
  }
  out.allVerified = [out.headerHash, out.txRoot, out.receiptsRoot, out.bloom].every((c) => c === out.blocks);
  return out;
}

// ---- run on both chains ----------------------------------------------------------------------------------------
/** a fresh Anvil per engine run: same txs, same blocks, nothing left over from a previous round */
async function startAnvil(port) {
  const url = `http://127.0.0.1:${port}`;
  const proc = spawn('anvil', ['--port', String(port), '--hardfork', 'cancun', '--silent'], { stdio: 'ignore' });
  const raw = async (method, params) => {
    const res = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
    if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code, data: res.error.data });
    return res.result;
  };
  for (let i = 0; ; i++) { try { await raw('eth_chainId', []); break; } catch { if (i > 100) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 100)); } }
  return { url, raw, kill: () => proc.kill() };
}

let exitCode = 1, allOk = true;
const user0 = privateKeyToAccount(TEST_KEYS[0]).address;
try {
  for (const [i, engine] of (process.env.TERRARIUM_ENGINES ?? 'js,revm').split(',').entries()) {
    const anvil = await startAnvil(8546 + i);
    try {
      const t1 = Date.now();
      const reference = await runScenario(anvil.raw, http(anvil.url));
      const anvilMs = Date.now() - t1;
      const b = reference.out;

      const t0 = Date.now();
      const sim = await createTerrarium({ chainId: 31337, engine });
      const bootMs = Date.now() - t0;
      const terrarium = await runScenario((method, params) => sim.provider.request({ method, params }), custom(sim.provider));
      const terrariumMs = Date.now() - t0 - bootMs;
      const a = terrarium.out;
      const stepDiffs = a.steps.map((st, k) => ({ label: st.label, status: st.status, gasUsed: st.gasUsed, identical: j(st) === j(b.steps[k]) }));
      const callsIdentical = j(a.calls) === j(b.calls), revertsIdentical = j(a.reverts) === j(b.reverts);
      const estimateRows = Object.keys(terrarium.estimates).map((k) => ({ label: k, terrarium: terrarium.estimates[k], anvil: reference.estimates[k], gasUsed: a.steps.find((st) => st.label === k)?.gasUsed }));
      const raw = (m, p) => sim.provider.request({ method: m, params: p });
      const parity = await rpcParity(raw, anvil.raw, { pair: a.calls.pair, user: user0, router: ROUTER, txHash: a.steps[5].hash, swapTopic: keccak256(toHex('Swap(address,uint256,uint256,uint256,uint256,address)')),
        expiredCall: encodeFunctionData({ abi: routerAbi, functionName: 'swapExactETHForTokens', args: [0n, [WETH, a.calls.pairTokens[0] === WETH ? a.calls.pairTokens[1] : a.calls.pairTokens[0]], user0, 1n] }) });
      const verified = { terrarium: await verifyBlocks(raw), anvil: await verifyBlocks(anvil.raw) };

      console.log(`\n================================================================ engine: ${engine} ================`);
      console.log('== transactions (identical = same hash, status, gasUsed, contractAddress, logs on both chains) ==');
      for (const st of stepDiffs) console.log(`${st.identical ? '  ok ' : ' DIFF'} ${st.status.padEnd(8)} gas ${String(st.gasUsed).padStart(7)}  ${st.label}`);
      console.log('== eth_call results ==', callsIdentical ? 'identical' : 'DIFFERENT'); if (!callsIdentical) console.log(j(a.calls), '\nanvil says:', j(b.calls));
      console.log('== revert payloads ==', revertsIdentical ? 'identical' : 'DIFFERENT'); for (const [k, v] of Object.entries(a.reverts)) console.log(`  ${k.padEnd(12)} -> ${v ? JSON.stringify(v.reason) : 'did not revert'}`); if (!revertsIdentical) console.log('anvil says:', j(b.reverts));
      console.log('== gas estimates (informational; must be >= gasUsed) ==');
      for (const r of estimateRows) console.log(`  terrarium ${String(r.terrarium).padStart(8)}  anvil ${String(r.anvil).padStart(8)}  used ${String(r.gasUsed).padStart(8)}  ${r.label}`);
      console.log('== verifiable blocks (header hash, tx root, receipts root, bloom recomputed from RPC output) ==');
      for (const [k, v] of Object.entries(verified)) console.log(`  ${k.padEnd(10)} blocks ${v.blocks}  headerHash ${v.headerHash}  txRoot ${v.txRoot}  receiptsRoot ${v.receiptsRoot}  bloom ${v.bloom}  stateRoot non-zero ${v.stateRootNonZero}  -> ${v.allVerified ? 'ok' : 'FAIL'}`);
      console.log('== RPC parity ==');
      for (const r of parity) console.log(`${r.ok ? '  ok ' : ' DIFF'} ${r.method} ${r.params}${r.ok ? '' : '\n        terrarium: ' + j(r.terrarium) + '\n        anvil:     ' + j(r.anvil)}`);
      console.log(`\nengine ${engine}: boot ${bootMs} ms, scenario ${terrariumMs} ms (${a.steps.length} txs incl. ${estimateRows.length} gas estimations)  ·  anvil ${anvilMs} ms${engine === 'revm' ? `  ·  revm runs ${sim.stats.runs}, rounds ${sim.stats.rounds}, inside wasm ${sim.stats.wasmMs} ms` : ''}`);

      const estimatesSound = estimateRows.every((r) => r.terrarium === 'reverts' ? r.anvil === 'reverts' : BigInt(r.terrarium) >= BigInt(r.gasUsed));
      const ok = stepDiffs.every((st) => st.identical) && callsIdentical && revertsIdentical && a.calls.codeInstalledByteIdentical && a.calls.swap1.allAgree
        && a.reverts['no approval']?.reason.includes('TransferHelper') && a.reverts['slippage']?.reason === 'UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT' && a.reverts['expired']?.reason === 'UniswapV2Router: EXPIRED'
        && a.steps.filter((st) => st.label.includes('reverts on-chain')).every((st) => st.status === 'reverted') && estimatesSound && parity.every((r) => r.ok)
        && verified.terrarium.allVerified && verified.anvil.allVerified && verified.terrarium.stateRootNonZero === verified.terrarium.blocks;
      console.log(ok ? `engine ${engine}: PASS` : `engine ${engine}: FAIL`);
      allOk = allOk && ok;
    } finally { anvil.kill(); }
  }
  console.log(allOk ? '\nPASS' : '\nFAIL');
  exitCode = allOk ? 0 : 1;
} catch (e) {
  console.error('test error:', e);
}
process.exit(exitCode);
