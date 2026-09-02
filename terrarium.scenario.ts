// terrarium.scenario.ts — what the Terrarium does when it boots under Frogpond. Runs inside the Worker.
// The real Uniswap V2 (mainnet bytecode) at its mainnet addresses, your PEPE, a seeded pool, and three bot frogs.
import { decodeEventLog, encodeFunctionData, getContractAddress, keccak256, maxUint256, parseAbi, parseEther, toHex, type Address } from 'viem';
import { defineScenario, type ScenarioContext } from 'terrarium/scenario';
import uniswap from 'terrarium/fixtures/uniswap-v2-mainnet.json';
import { PEPE } from './src/generated/contracts';

const ROUTER = (import.meta.env.VITE_ROUTER_ADDRESS ?? uniswap.contracts.router.address) as Address;
const TOKEN = import.meta.env.VITE_TOKEN_ADDRESS as Address;
const routerAbi = parseAbi([
  'function WETH() view returns (address)',
  'function factory() view returns (address)',
  'function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256, uint256, uint256)',
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
]);
const factoryAbi = parseAbi(['function getPair(address, address) view returns (address)']);
const swapEvent = parseAbi(['event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)']);
const SWAP_TOPIC = keccak256(toHex('Swap(address,uint256,uint256,uint256,uint256,address)'));

export default defineScenario({
  chainId: Number(import.meta.env.VITE_CHAIN_ID ?? 31337),
  seed: 1337,
  persist: 'frogpond',
  actorsLabel: 'Pond life',

  async setup(ctx) {
    const { pub, accounts, state } = ctx;
    const treasury = accounts[9];
    // 1. the real Uniswap V2 — byte-identical mainnet runtime code at the mainnet addresses
    await ctx.install(uniswap);
    state.weth = await pub.readContract({ address: ROUTER, abi: routerAbi, functionName: 'WETH' });
    state.factory = await pub.readContract({ address: ROUTER, abi: routerAbi, functionName: 'factory' });
    // 2. your contract: PEPE, the treasury's first tx, so its address is deterministic and lives in .env like on mainnet
    if ((await ctx.codeAt(TOKEN)) === '0x') {
      const expected = getContractAddress({ from: treasury, nonce: BigInt(await pub.getTransactionCount({ address: treasury })) });
      if (expected.toLowerCase() !== TOKEN.toLowerCase()) throw new Error(`PEPE would deploy at ${expected} but VITE_TOKEN_ADDRESS is ${TOKEN}; reset the terrarium`);
      const t = ctx.wallet(treasury);
      await ctx.wait(t.deployContract({ abi: PEPE.abi, bytecode: PEPE.bytecode, args: [parseEther('420690000000')] }));
      // 3. seed the pool through the router (this creates the pair): 10 ETH + 8M PEPE -> 1 PEPE = 1,250 gwei; 50M PEPE to everyone
      await ctx.wait(t.writeContract({ address: TOKEN, abi: PEPE.abi, functionName: 'approve', args: [ROUTER, maxUint256] }));
      await ctx.wait(t.writeContract({ address: ROUTER, abi: routerAbi, functionName: 'addLiquidityETH', args: [TOKEN, parseEther('8000000'), parseEther('8000000'), parseEther('10'), treasury, ctx.deadline()], value: parseEther('10') }));
      for (const a of accounts.slice(0, 9)) await ctx.wait(t.writeContract({ address: TOKEN, abi: PEPE.abi, functionName: 'transfer', args: [a, parseEther('50000000')] }));
    }
    state.pair = await pub.readContract({ address: state.factory, abi: factoryAbi, functionName: 'getPair', args: [TOKEN, state.weth] });
    state.tokenIsToken0 = TOKEN.toLowerCase() < state.weth.toLowerCase();
    state.frogs = accounts.slice(6, 9);
  },

  // pond life: three frogs trade on their own (seeded, reproducible), and one of them fades every human swap a block later
  actors: [
    { name: 'random frog', every: 5000, run: async (ctx) => {
      const frog = ctx.state.frogs[Math.floor(ctx.random() * 3)], buy = ctx.random() < 0.5;
      await frogSwap(ctx, frog, buy ? 'buy' : 'sell', buy ? parseEther((0.05 + ctx.random() * 0.4).toFixed(3)) : parseEther(String(20_000 + Math.floor(ctx.random() * 300_000))));
    } },
    { name: 'arbitrage frog', on: (ctx) => ({ address: ctx.state.pair, topics: [SWAP_TOPIC] }), run: async (ctx, log) => {
      const { args } = decodeEventLog({ abi: swapEvent, eventName: 'Swap', data: log.data, topics: log.topics });
      if (ctx.state.frogs.some((f: Address) => f.toLowerCase() === args.to.toLowerCase())) return;
      const t0 = ctx.state.tokenIsToken0;
      const ethIn = t0 ? args.amount1In : args.amount0In, tokenOut = t0 ? args.amount0Out : args.amount1Out, ethOut = t0 ? args.amount1Out : args.amount0Out;
      await new Promise((r) => setTimeout(r, 900));
      if (ethIn > 0n) await frogSwap(ctx, ctx.state.frogs[1], 'sell', tokenOut / 3n); else await frogSwap(ctx, ctx.state.frogs[1], 'buy', ethOut / 3n);
    } },
  ],

  status: (ctx) => ({ addresses: { router: ROUTER, token: TOKEN, weth: ctx.state.weth, factory: ctx.state.factory, pair: ctx.state.pair } }),
});

async function frogSwap(ctx: ScenarioContext, frog: Address, direction: 'buy' | 'sell', size: bigint) {
  const deadline = ctx.deadline(600);
  if (direction === 'buy') await ctx.sim.sendAs(frog, { to: ROUTER, value: toHex(size), data: encodeFunctionData({ abi: routerAbi, functionName: 'swapExactETHForTokens', args: [0n, [ctx.state.weth, TOKEN], frog, deadline] }) });
  else {
    await ctx.sim.sendAs(frog, { to: TOKEN, data: encodeFunctionData({ abi: PEPE.abi, functionName: 'approve', args: [ROUTER, size] }) });
    await ctx.sim.sendAs(frog, { to: ROUTER, data: encodeFunctionData({ abi: routerAbi, functionName: 'swapExactTokensForETH', args: [size, 0n, [TOKEN, ctx.state.weth], frog, deadline] }) });
  }
}
