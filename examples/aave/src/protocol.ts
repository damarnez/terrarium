// Aave V3 on Ethereum mainnet: the addresses and the slice of the ABI this example uses. Plain viem, nothing else.
import { parseAbi } from 'viem';

export const AAVE = {
  pool: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
} as const;

export const poolAbi = parseAbi([
  'function ADDRESSES_PROVIDER() view returns (address)',
  'function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
  'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)',
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) returns (uint256)',
]);
export const providerAbi = parseAbi(['function getPriceOracle() view returns (address)']);
export const oracleAbi = parseAbi(['function getAssetPrice(address asset) view returns (uint256)', 'function getSourceOfAsset(address asset) view returns (address)', 'function BASE_CURRENCY_UNIT() view returns (uint256)']);
export const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address owner, address spender) view returns (uint256)', 'function approve(address spender, uint256 value) returns (bool)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
export const RAY = 10n ** 27n;
export const aprPercent = (ray: bigint) => Number(ray) / 1e27 * 100;
