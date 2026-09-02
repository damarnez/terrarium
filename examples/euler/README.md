# Example: Euler V2 (mainnet vaults, offline)

Deposit WETH into **eWETH-2**, enable it as collateral, enable **eUSDC-2** as your controller, borrow USDC — against the
real Euler Vault Kit vaults and the real Ethereum Vault Connector from mainnet, inside the page, offline.

```bash
npm run example:euler       # http://localhost:5175 → Connect wallet → Terrarium Wallet
```

## What to look at
- **Euler's account model in the UI.** Borrowing needs two one-time transactions the UI walks you through: enable the
  collateral vault for your account, enable the borrow vault as controller. The position card shows both flags.
- **Risk-adjusted numbers from the vault itself.** `accountLiquidity` returns the LTV-adjusted collateral value and the
  liability value; the UI shows "borrowing power used" from them. Compare with the 84 % borrow LTV shown in the market card.
- **Oracle staleness is real.** Dev bar → **+1 hour** and pricing reverts with `PriceOracle_TooStale`: the recorded
  Chainlink round is older than Euler's adapter allows. A mainnet fork on Anvil does exactly the same. `debtOf` still
  works (no oracle), so the debt is visibly larger. The scenario runs on `clock: 'recording'` so the fixture does not
  rot on its own; only your time travel does this.

## How it is built
Same recipe as the Aave example: `record.mjs` (fork, deal, snapshot, exercise every path, revert, dump →
`fixtures/euler-mainnet.json`, ≈500 KB), `terrarium.scenario.ts` (offline restore of the fixture), `src/` (an ordinary
dapp: `.env` addresses, viem, EIP-6963), `test.mjs` (offline replay on both engines, `npm run test:examples`),
`npm run record:euler` to re-record.
