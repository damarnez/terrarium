// Euler V2 (EVK vaults + EVC) on Ethereum mainnet: the addresses and the slice of the ABI this example uses.
import { parseAbi } from 'viem';

export const EULER = {
  evc: '0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383',
  eWeth: '0xD8b27CF359b7D15710a5BE299AF6e7Bf904984C2',   // eWETH-2: the collateral vault
  eUsdc: '0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9',   // eUSDC-2: the borrow vault (accepts eWETH-2 at 84 % LTV)
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
} as const;

export const vaultAbi = parseAbi([
  'function asset() view returns (address)',
  'function symbol() view returns (string)',
  'function deposit(uint256 assets, address receiver) returns (uint256)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256)',
  'function maxWithdraw(address owner) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function borrow(uint256 amount, address receiver) returns (uint256)',
  'function repay(uint256 amount, address receiver) returns (uint256)',
  'function debtOf(address account) view returns (uint256)',
  'function disableController()',
  'function accountLiquidity(address account, bool liquidation) view returns (uint256 collateralValue, uint256 liabilityValue)',
  'function LTVBorrow(address collateral) view returns (uint16)',
  'function LTVLiquidation(address collateral) view returns (uint16)',
  'function interestRate() view returns (uint256)',
  'function cash() view returns (uint256)',
  'function totalBorrows() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function oracle() view returns (address)',
  'function unitOfAccount() view returns (address)',
]);
export const evcAbi = parseAbi([
  'function enableCollateral(address account, address vault)',
  'function disableCollateral(address account, address vault)',
  'function enableController(address account, address vault)',
  'function getCollaterals(address account) view returns (address[])',
  'function getControllers(address account) view returns (address[])',
]);
export const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address owner, address spender) view returns (uint256)', 'function approve(address spender, uint256 value) returns (bool)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
/** EVK interestRate() is a per-second rate scaled by 1e27; APY = (1 + r)^seconds_per_year - 1 */
export const apyPercent = (spy: bigint) => (Math.pow(1 + Number(spy) / 1e27, 365 * 24 * 3600) - 1) * 100;
