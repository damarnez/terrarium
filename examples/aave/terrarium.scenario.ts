// The Terrarium behind the Aave example: mainnet state at the recorded block (real Pool, aTokens, oracle, WETH, USDC),
// the user holding 100 WETH, and a dev-bar control that moves the ETH price by swapping the Chainlink source for a fixed
// feed — the way to see the health factor react without waiting for the market.
import { defineScenario } from 'terrarium/scenario';
import fixture from './fixtures/aave-mainnet.json';
import { FixedPriceFeed } from './src/generated/contracts';
import { AAVE, oracleAbi } from './src/protocol';

const forkRpc = import.meta.env.VITE_FORK_RPC || undefined;

export default defineScenario({
  chainId: 1,
  seed: 7,
  engine: 'revm',
  persist: `aave-example-${fixture.blockNumber}`,   // keyed by the fixture: a re-recorded fixture starts fresh
  fork: { url: forkRpc, blockNumber: fixture.blockNumber, offline: !forkRpc },   // offline by default: every read must come from the fixture
  restore: fixture.dump,
  clock: 'recording',   // interest and index math continue from the recorded moment; the fixture never rots

  async setup(ctx) {
    ctx.state.ethSource = fixture.addresses.ethSource;
    ctx.state.basePrice = BigInt(fixture.expected.ethPrice);
    if (ctx.firstBoot) await ctx.sim.deal(AAVE.usdc, ctx.accounts[0], 1_000n * 10n ** 6n);   // a little USDC to repay interest with
  },

  methods: {
    /** move the ETH price by `pct` percent from the recorded mainnet price (0 = back to the real feed) */
    async terrarium_ethPrice(ctx, pct: number) {
      const src = ctx.state.ethSource as `0x${string}`;
      if (!ctx.state.original) ctx.state.original = { code: await ctx.codeAt(src), slots: await Promise.all(['0x0', '0x1', '0x2'].map((s) => ctx.rpc('eth_getStorageAt', [src, s, 'latest']))) };
      if (pct === 0) {
        await ctx.rpc('anvil_setCode', [src, ctx.state.original.code]);
        for (const [i, v] of ctx.state.original.slots.entries()) await ctx.rpc('anvil_setStorageAt', [src, '0x' + i.toString(16), v]);
        ctx.state.override = null;
      } else {
        const answer = (ctx.state.basePrice * BigInt(Math.round((100 + pct) * 100))) / 10000n;
        await ctx.rpc('anvil_setCode', [src, FixedPriceFeed.deployedBytecode]);
        await ctx.sim.setState(src, FixedPriceFeed.storageLayout, { answer, decimals: 8, roundId: 1 });
        ctx.state.override = pct;
      }
      await ctx.rpc('evm_mine');   // a block, so the UI notices
      return ctx.pub.readContract({ address: fixture.addresses.oracle as `0x${string}`, abi: oracleAbi, functionName: 'getAssetPrice', args: [AAVE.weth] }).then(String);
    },
  },
  controls: [
    { label: 'ETH −30%', method: 'terrarium_ethPrice', params: [-30], title: 'Crash the ETH price 30 % below the recorded mainnet price (fixed feed installed at the Chainlink source address)' },
    { label: 'ETH −60%', method: 'terrarium_ethPrice', params: [-60], title: 'Crash the ETH price 60 %: positions near the liquidation threshold go under' },
    { label: 'ETH +30%', method: 'terrarium_ethPrice', params: [30], title: 'ETH price 30 % above the recorded mainnet price' },
    { label: 'ETH price: mainnet', method: 'terrarium_ethPrice', params: [0], title: 'Put the real Chainlink feed back' },
  ],
  status: (ctx) => ({ addresses: fixture.addresses, forkBlock: fixture.blockNumber, ethPriceOverridePct: ctx.state.override ?? null }),
});
