// terrarium.scenario.ts — what the Terrarium does when it boots under Frogpond. Runs inside the Worker.
// The real Uniswap V2 (mainnet bytecode) at its mainnet addresses, your PEPE, a seeded pool, and three bot frogs.
import { decodeEventLog, encodeFunctionData, formatEther, getContractAddress, keccak256, maxUint256, parseAbi, parseEther, toHex, type Address } from 'viem';
import { defineScenario, reply, type ScenarioContext } from 'terrarium/scenario';
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
const pairAbi = parseAbi(['function getReserves() view returns (uint112, uint112, uint32)']);
// the indexer the dapp would query on mainnet (VITE_SUBGRAPH_URL): answered here from this chain's own logs and reserves
const SUBGRAPH = import.meta.env.VITE_SUBGRAPH_URL ?? 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2';
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

  // ---- the dapp's off-chain reads: a Uniswap V2 subgraph, computed from the chain in this Worker ------------------------
  // The dapp POSTs the same GraphQL it would send to The Graph on mainnet. There is no indexer in the page, so the scenario
  // answers `pair` and `swaps` from getReserves() and the pair's Swap logs. Two dev-bar buttons make the indexer fail the
  // way real ones do: down (HTTP 503) and behind the chain by three blocks.
  http: [{
    name: 'uniswap-v2-subgraph',
    match: SUBGRAPH,
    handler: (ctx) => (ctx.state.indexer === 'down' ? reply({ message: 'indexer unavailable' }, { status: 503 }) : undefined),   // the gate
    graphql: {
      pair: async (ctx, q) => {
        if (String(q.args.id).toLowerCase() !== String(ctx.state.pair).toLowerCase()) return null;
        const head = await indexedHead(ctx);
        const [r0, r1] = await ctx.pub.readContract({ address: ctx.state.pair, abi: pairAbi, functionName: 'getReserves', blockNumber: head });
        const swaps = await swapLogs(ctx, head);
        const sum = (k: 'amount0In' | 'amount0Out' | 'amount1In' | 'amount1Out') => swaps.reduce((a, s) => a + s.args[k], 0n);
        const [t0, t1] = ctx.state.tokenIsToken0 ? [TOKEN, ctx.state.weth] : [ctx.state.weth, TOKEN];
        return { id: String(ctx.state.pair).toLowerCase(), token0: { id: t0.toLowerCase(), symbol: t0 === TOKEN ? 'PEPE' : 'WETH' }, token1: { id: t1.toLowerCase(), symbol: t1 === TOKEN ? 'PEPE' : 'WETH' },
          reserve0: formatEther(r0), reserve1: formatEther(r1), txCount: String(swaps.length), volumeToken0: formatEther(sum('amount0In') + sum('amount0Out')), volumeToken1: formatEther(sum('amount1In') + sum('amount1Out')) };
      },
      swaps: async (ctx, q) => {
        const where = (q.args.where ?? {}) as { pair?: string };
        if (where.pair && where.pair.toLowerCase() !== String(ctx.state.pair).toLowerCase()) return [];
        const head = await indexedHead(ctx);
        const logs = await swapLogs(ctx, head);
        const blocks = new Map<bigint, bigint>();
        for (const l of logs) if (!blocks.has(l.blockNumber)) blocks.set(l.blockNumber, (await ctx.pub.getBlock({ blockNumber: l.blockNumber })).timestamp);
        const rows = logs.map((l) => ({ id: `${l.transactionHash}-${l.logIndex}`, timestamp: String(blocks.get(l.blockNumber)), pair: { id: String(ctx.state.pair).toLowerCase() }, sender: l.args.sender, to: l.args.to,
          amount0In: formatEther(l.args.amount0In), amount1In: formatEther(l.args.amount1In), amount0Out: formatEther(l.args.amount0Out), amount1Out: formatEther(l.args.amount1Out), transaction: { id: l.transactionHash, blockNumber: String(l.blockNumber) }, logIndex: String(l.logIndex) }));
        if (q.args.orderBy === 'timestamp') rows.sort((a, b) => (Number(b.timestamp) - Number(a.timestamp) || Number(b.logIndex) - Number(a.logIndex)) * (q.args.orderDirection === 'desc' ? 1 : -1));
        return rows.slice(Number(q.args.skip ?? 0), Number(q.args.skip ?? 0) + Number(q.args.first ?? 100));
      },
    },
  }],
  methods: {
    /** how the indexer behaves: 'live' (answers the head), 'behind' (three blocks late), 'down' (HTTP 503). Mines a block so the UI re-queries. */
    async terrarium_indexer(ctx, mode: 'live' | 'behind' | 'down') { ctx.state.indexer = mode; await ctx.rpc('evm_mine'); return mode; },
  },
  controls: [
    { label: 'Indexer: down', method: 'terrarium_indexer', params: ['down'], title: 'The subgraph answers HTTP 503: what does the UI show while its indexer is unavailable?' },
    { label: 'Indexer: 3 blocks behind', method: 'terrarium_indexer', params: ['behind'], title: 'The subgraph lags three blocks behind the chain: stale swaps and reserves next to a live head' },
    { label: 'Indexer: live', method: 'terrarium_indexer', params: ['live'], title: 'The subgraph answers from the current head again' },
  ],

  status: (ctx) => ({ addresses: { router: ROUTER, token: TOKEN, weth: ctx.state.weth, factory: ctx.state.factory, pair: ctx.state.pair }, indexer: ctx.state.indexer ?? 'live' }),
});

/** the block the "indexer" has reached: the head, or three blocks behind it */
async function indexedHead(ctx: ScenarioContext): Promise<bigint> {
  const head = ctx.sim.blockNumber as bigint;
  return ctx.state.indexer === 'behind' ? (head > 3n ? head - 3n : 0n) : head;
}
/** every Swap on the pair up to `toBlock`, decoded (a real indexer would keep these in a database; this chain is small) */
async function swapLogs(ctx: ScenarioContext, toBlock: bigint) {
  return ctx.pub.getContractEvents({ address: ctx.state.pair as Address, abi: swapEvent, eventName: 'Swap', fromBlock: 0n, toBlock, strict: true });
}

async function frogSwap(ctx: ScenarioContext, frog: Address, direction: 'buy' | 'sell', size: bigint) {
  const deadline = ctx.deadline(600);
  if (direction === 'buy') await ctx.sim.sendAs(frog, { to: ROUTER, value: toHex(size), data: encodeFunctionData({ abi: routerAbi, functionName: 'swapExactETHForTokens', args: [0n, [ctx.state.weth, TOKEN], frog, deadline] }) });
  else {
    await ctx.sim.sendAs(frog, { to: TOKEN, data: encodeFunctionData({ abi: PEPE.abi, functionName: 'approve', args: [ROUTER, size] }) });
    await ctx.sim.sendAs(frog, { to: ROUTER, data: encodeFunctionData({ abi: routerAbi, functionName: 'swapExactTokensForETH', args: [size, 0n, [TOKEN, ctx.state.weth], frog, deadline] }) });
  }
}
