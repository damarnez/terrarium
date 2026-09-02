// test/fork-offline.mjs — REPLAY on the recorded mainnet fork with the network unplugged.
//
// Restores the fixture recorded by fork-record.mjs (real USDC proxy, real Uniswap V2 pair and router, at a real mainnet
// block), asserts the recorded swap is what a fresh calculation says it should be, then sends a NEW swap. Every read
// must be served from the fixture: fetch() is replaced with a function that fails the test if anything tries to
// reach a node. This is what CI runs: deterministic, offline, zero RPC quota.
//
//   npm run test:fork
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, custom, defineChain, parseAbi } from 'viem';
import { createTerrarium } from 'terrarium/engine';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/fork-mainnet-usdc-swap.json', import.meta.url), 'utf8'));
const { USDC, WETH, ROUTER, pair, user } = fixture.addresses;
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const router = parseAbi(['function getAmountsOut(uint256, address[]) view returns (uint256[])', 'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])']);
const pairAbi = parseAbi(['function getReserves() view returns (uint112, uint112, uint32)', 'function token0() view returns (address)']);
const v2Out = (amountIn, rIn, rOut) => (amountIn * 997n * rOut) / (rIn * 1000n + amountIn * 997n);

let networkAttempts = 0;
globalThis.fetch = async (url) => { networkAttempts++; throw new Error(`offline test tried to reach the network: ${url}`); };

const t0 = Date.now();
const sim = await createTerrarium({ chainId: 1, fork: { url: 'http://127.0.0.1:9/unplugged', blockNumber: fixture.blockNumber }, restore: fixture.dump, seed: 1 });
const chain = defineChain({ id: 1, name: 'mainnet-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
const pub = createPublicClient({ chain, transport: custom(sim.provider), pollingInterval: 20 });
const wallet = createWalletClient({ chain, transport: custom(sim.provider), account: user });
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const out = { restoredMs: Date.now() - t0, forkBlock: fixture.blockNumber, headAfterRestore: String(sim.blockNumber) };

// 1. the recorded state is there: WETH from the recorded swap, USDC left over
out.wethFromRecordedSwap = (await read(WETH, erc20, 'balanceOf', [user])).toString();
out.usdcLeft = (await read(USDC, erc20, 'balanceOf', [user])).toString();
out.recordedSwapStillCorrect = out.wethFromRecordedSwap === fixture.expected.received;

// 2. a NEW transaction on the real contracts, offline: swap 1,000 more USDC
const token0 = await read(pair, pairAbi, 'token0');
const [r0, r1] = await read(pair, pairAbi, 'getReserves');
const [rUSDC, rWETH] = token0.toLowerCase() === USDC.toLowerCase() ? [r0, r1] : [r1, r0];
const amountIn = 1_000n * 10n ** 6n;
const quote = await read(ROUTER, router, 'getAmountsOut', [amountIn, [USDC, WETH]]);
const receipt = await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: ROUTER, abi: router, functionName: 'swapExactTokensForTokens', args: [amountIn, 0n, [USDC, WETH], user, sim.now() + 3600n] }) });
const wethAfter = await read(WETH, erc20, 'balanceOf', [user]);
out.newSwap = { status: receipt.status, gasUsed: receipt.gasUsed.toString(), routerQuote: quote[1].toString(), formula: v2Out(amountIn, rUSDC, rWETH).toString(), received: (wethAfter - BigInt(out.wethFromRecordedSwap)).toString() };
out.newSwapAgrees = out.newSwap.routerQuote === out.newSwap.formula && out.newSwap.formula === out.newSwap.received && receipt.status === 'success';
out.networkAttempts = networkAttempts;
out.totalMs = Date.now() - t0;
console.log(JSON.stringify(out, null, 2));
const ok = out.recordedSwapStillCorrect && out.newSwapAgrees && networkAttempts === 0;
console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
