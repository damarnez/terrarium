// The Terrarium behind the Euler example: mainnet state at the recorded block (EVC, eWETH-2, eUSDC-2, oracles, WETH,
// USDC) and the user holding 100 WETH. Offline unless VITE_FORK_RPC is set.
import { defineScenario } from 'terrarium/scenario';
import fixture from './fixtures/euler-mainnet.json';
import { EULER } from './src/protocol';

const forkRpc = import.meta.env.VITE_FORK_RPC || undefined;

export default defineScenario({
  chainId: 1,
  seed: 11,
  engine: 'revm',
  persist: `euler-example-${fixture.blockNumber}`,   // keyed by the fixture: a re-recorded fixture starts fresh
  fork: { url: forkRpc, blockNumber: fixture.blockNumber, offline: !forkRpc },
  restore: fixture.dump,
  clock: 'recording',   // Euler's Chainlink adapters revert (PriceOracle_TooStale) once the recorded round is older than their limit
  async setup(ctx) {
    if (ctx.firstBoot) await ctx.sim.deal(EULER.usdc, ctx.accounts[0], 1_000n * 10n ** 6n);   // a little USDC to repay interest with
  },
  status: () => ({ addresses: fixture.addresses, forkBlock: fixture.blockNumber }),
});
