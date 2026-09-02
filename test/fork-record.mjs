// test/fork-record.mjs — RECORD a fork session against Ethereum mainnet into an offline fixture (needs network).
//
// The Terrarium forks mainnet lazily: every account, code and storage slot the EVM touches is fetched once and
// recorded. Here a user is dealt real USDC (a proxy contract — `deal` finds the balance slot by watching SLOADs) and
// swaps it for WETH through the real Uniswap V2 router against the real USDC/WETH pair. The dump of that session is
// a complete offline fixture: test/fork-offline.mjs replays new transactions on it with the network unplugged.
//
//   npm run test:fork:record            (FORK_RPC=https://... to use another endpoint)
import { writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, custom, defineChain, parseAbi, maxUint256 } from 'viem';
import { createTerrarium } from 'terrarium/engine';

const RPC = process.env.FORK_RPC ?? 'https://ethereum-rpc.publicnode.com';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D', FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address, uint256) returns (bool)', 'function decimals() view returns (uint8)']);
const router = parseAbi(['function getAmountsOut(uint256, address[]) view returns (uint256[])', 'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])']);
const factory = parseAbi(['function getPair(address, address) view returns (address)']);
const pairAbi = parseAbi(['function getReserves() view returns (uint112, uint112, uint32)', 'function token0() view returns (address)']);
const v2Out = (amountIn, rIn, rOut) => (amountIn * 997n * rOut) / (rIn * 1000n + amountIn * 997n);

const remote = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const blockNumber = Number(await remote('eth_blockNumber', [])) - 8;   // a few blocks back: past any reorg, still within non-archive state
console.log(`forking mainnet at block ${blockNumber} via ${RPC}`);
const t0 = Date.now();
const sim = await createTerrarium({ chainId: 1, fork: { url: RPC, blockNumber }, seed: 1 });
const chain = defineChain({ id: 1, name: 'mainnet-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
const pub = createPublicClient({ chain, transport: custom(sim.provider), pollingInterval: 20 });
const user = sim.accounts[0].address;
const wallet = createWalletClient({ chain, transport: custom(sim.provider), account: user });
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });

const pair = await read(FACTORY, factory, 'getPair', [USDC, WETH]);
const token0 = await read(pair, pairAbi, 'token0');
const [r0, r1] = await read(pair, pairAbi, 'getReserves');
const [reserveUSDC, reserveWETH] = token0.toLowerCase() === USDC.toLowerCase() ? [r0, r1] : [r1, r0];
console.log(`real USDC/WETH pair ${pair}: ${Number(reserveUSDC) / 1e6} USDC / ${Number(reserveWETH) / 1e18} WETH`);

await sim.deal(USDC, user, 10_000n * 10n ** 6n);                        // 10,000 USDC out of thin air (proxy: the slot is found, not guessed)
const usdcBefore = await read(USDC, erc20, 'balanceOf', [user]);
const amountIn = 5_000n * 10n ** 6n;
const quote = await read(ROUTER, router, 'getAmountsOut', [amountIn, [USDC, WETH]]);
await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: USDC, abi: erc20, functionName: 'approve', args: [ROUTER, maxUint256] }) });
const receipt = await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: ROUTER, abi: router, functionName: 'swapExactTokensForTokens', args: [amountIn, 0n, [USDC, WETH], user, sim.now() + 3600n] }) });
const wethOut = await read(WETH, erc20, 'balanceOf', [user]);
const expected = { usdcDealt: usdcBefore.toString(), routerQuote: quote[1].toString(), formula: v2Out(amountIn, reserveUSDC, reserveWETH).toString(), received: wethOut.toString(), status: receipt.status, gasUsed: receipt.gasUsed.toString() };
console.log(expected);
if (!(expected.routerQuote === expected.formula && expected.formula === expected.received && receipt.status === 'success')) { console.error('FAIL: quote, formula and execution disagree'); process.exit(1); }

const dump = await sim.dumpState();
const fixture = { source: `Ethereum mainnet fork at block ${blockNumber}, recorded ${new Date().toISOString()} via ${RPC}`, blockNumber, addresses: { USDC, WETH, ROUTER, FACTORY, pair, user }, remoteReads: { accounts: Object.keys(dump.remote.accounts).length, code: Object.keys(dump.remote.code).length, storage: Object.keys(dump.remote.storage).length }, expected, dump };
writeFileSync(new URL('./fixtures/fork-mainnet-usdc-swap.json', import.meta.url), JSON.stringify(fixture));
console.log(`recorded ${fixture.remoteReads.accounts} accounts, ${fixture.remoteReads.code} code blobs, ${fixture.remoteReads.storage} storage slots in ${Date.now() - t0} ms -> test/fixtures/fork-mainnet-usdc-swap.json\nPASS`);
