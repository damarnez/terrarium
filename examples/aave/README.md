# Example: Aave V3 (mainnet contracts, offline)

An ordinary Aave frontend — supply WETH, borrow USDC, repay, withdraw — running against the **real Aave V3 Pool,
aTokens, debt tokens and price oracle** from Ethereum mainnet, inside the page, with no node and no network.

```bash
npm run example:aave        # http://localhost:5174 → Connect wallet → Terrarium Wallet
```

## What to look at
- **Health factor: the Pool's vs this UI's.** The UI computes `collateral × liquidation threshold / debt` itself and shows
  the Pool's answer next to it, with a ✓ when they agree to 1e-6. Every action also shows the projected health factor
  before you send it. That is the point of the whole exercise: your frontend math checked against the real contract.
- **Interest.** Dev bar → **+1 hour**: the borrowed USDC grows, the supplied aWETH grows, at the mainnet rates of the
  recorded block.
- **A price shock.** Dev bar → **ETH −30% / −60% / +30%**. The scenario installs a fixed price feed *at the address of
  the Chainlink source* (`anvil_setCode` + a storage write by variable name), so `AaveOracle.getAssetPrice` and every
  consumer keep reading "the oracle" and the health factor reacts. **ETH price: mainnet** puts the real feed back.
- **Wallet failure modes.** Reject next tx, a slow wallet, late receipts: all in the dev bar, as in every example.

## Why there is a `contracts/FixedPriceFeed.sol` here, and no Aave source anywhere
The Pool, its proxy and implementation, the aTokens, the debt tokens, the oracle and the Chainlink aggregators all arrive
as bytes from the recorded fork: the Terrarium fetched their code and the storage the UI touched at the recorded block, so
there is nothing to compile. The one thing that does not exist on mainnet is a price you can move. `FixedPriceFeed.sol` is a
20-line Chainlink-shaped contract with a settable `answer`; the scenario installs its runtime code *at the aggregator's
address* and writes `answer` / `decimals` / `roundId` by variable name. Aave keeps reading "the oracle" and the health
factor reacts. `npm run build:contracts` compiles it into `src/generated/contracts.ts` (abi, bytecode, deployedBytecode,
storageLayout). The Euler example needs no Solidity at all: everything it shows is in the recorded state already.

## How it is built
- `record.mjs` forks mainnet (`createTerrarium({ fork })`), deals the user 100 WETH, snapshots, then exercises every path
  the UI takes (supply, borrow, an hour passing, repay, withdraw, oracle reads) so all the state they touch is recorded.
  It reverts to the clean snapshot before dumping: `fixtures/aave-mainnet.json` starts clean but complete (≈450 KB).
- `terrarium.scenario.ts` restores that fixture as the baseline, `fork: { offline: true }` (any read the fixture cannot
  answer is an error, listed in the dev bar), `clock: 'recording'`, and the ETH price control.
- `src/` is the dapp: `.env` addresses, viem, EIP-6963. It does not know the Terrarium exists.
- `test.mjs` replays the fixture offline: health factor vs client math, interest after an hour, the
  price shock halving the health factor, repay-all and withdraw-all. `npm run test:examples`.
- Re-record against current mainnet: `npm run record:aave` (needs network; a public RPC works). The same thing without
  a hand-written recorder: `npx terrarium record pool=… weth=… usdc=… --rpc URL --chain 1 --block N --script warm.mjs`. Set `VITE_FORK_RPC` in `.env` to run the
  scenario online instead of offline: reads the fixture lacks are fetched, and the dev bar no longer counts misses.
