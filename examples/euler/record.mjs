// examples/euler/record.mjs — RECORD the Euler V2 mainnet state this example needs into an offline fixture (needs network).
// Same recipe as the Aave recorder: fork, deal WETH, snapshot, exercise every path (deposit, enable collateral +
// controller, borrow, time, repay, withdraw), revert to the clean snapshot, dump.
//   npm run record:euler
import { writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, custom, defineChain, formatUnits, maxUint256, parseEther } from 'viem';
import { createTerrarium } from 'terrarium/engine';
import { EULER, vaultAbi, evcAbi, erc20Abi, apyPercent } from './src/protocol.ts';

const RPC = process.env.FORK_RPC ?? 'https://ethereum-rpc.publicnode.com';
const remote = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const blockNumber = Number(await remote('eth_blockNumber', [])) - 8;
console.log(`forking mainnet at block ${blockNumber} via ${RPC}`);
const t0 = Date.now();
const sim = await createTerrarium({ chainId: 1, engine: process.env.TERRARIUM_ENGINE ?? 'revm', fork: { url: RPC, blockNumber }, seed: 1 });
const chain = defineChain({ id: 1, name: 'mainnet-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
const pub = createPublicClient({ chain, transport: custom(sim.provider), pollingInterval: 20 });
const user = sim.accounts[0].address;
const w = createWalletClient({ chain, transport: custom(sim.provider), account: user });
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const tx = async (label, req) => {
  try { const r = await pub.waitForTransactionReceipt({ hash: await w.writeContract(req) }); if (r.status !== 'success') throw new Error(`${label} reverted on-chain`); console.log(`  ${label}: ${r.gasUsed} gas`); return r; }
  catch (e) { const rev = e.walk?.((x) => x?.name === 'ContractFunctionRevertedError'); console.error(`  ${label} FAILED: ${rev?.reason ?? rev?.data?.errorName ?? e.shortMessage ?? e.message}`); throw e; }
};
const { evc, eWeth, eUsdc, weth, usdc } = EULER;

// ---- discover + warm up every read the UI does ----
const market = async () => Promise.all([read(eUsdc, vaultAbi, 'LTVBorrow', [eWeth]), read(eUsdc, vaultAbi, 'LTVLiquidation', [eWeth]), read(eWeth, vaultAbi, 'interestRate'), read(eUsdc, vaultAbi, 'interestRate'), read(eUsdc, vaultAbi, 'cash'), read(eUsdc, vaultAbi, 'totalBorrows'), read(eWeth, vaultAbi, 'totalAssets'), read(eUsdc, vaultAbi, 'totalAssets')]);
const position = async () => Promise.all([read(eWeth, vaultAbi, 'balanceOf', [user]), read(eWeth, vaultAbi, 'maxWithdraw', [user]), read(eUsdc, vaultAbi, 'debtOf', [user]), read(evc, evcAbi, 'getCollaterals', [user]), read(evc, evcAbi, 'getControllers', [user]), read(weth, erc20Abi, 'balanceOf', [user]), read(usdc, erc20Abi, 'balanceOf', [user]), read(weth, erc20Abi, 'allowance', [user, eWeth]), read(usdc, erc20Abi, 'allowance', [user, eUsdc])]);
const liquidity = () => read(eUsdc, vaultAbi, 'accountLiquidity', [user, false]).catch(() => [0n, 0n]);   // reverts until a controller is enabled
for (const v of [eWeth, eUsdc]) await Promise.all([read(v, vaultAbi, 'asset'), read(v, vaultAbi, 'symbol'), read(v, vaultAbi, 'oracle'), read(v, vaultAbi, 'unitOfAccount')]);
for (const t of [weth, usdc]) await Promise.all([read(t, erc20Abi, 'decimals'), read(t, erc20Abi, 'symbol')]);
const m = await market();
console.log({ ltvBorrow: m[0] / 100 + '%', ltvLiquidation: m[1] / 100 + '%', wethSupplyApy: apyPercent(m[2]).toFixed(2) + '%', usdcBorrowApy: apyPercent(m[3]).toFixed(2) + '%', usdcCash: formatUnits(m[4], 6), usdcBorrows: formatUnits(m[5], 6) });

// ---- the user: 100 WETH, then a clean snapshot ----
await sim.deal(weth, user, parseEther('100'));
await position(); await liquidity();
const clean = await sim.snapshot();

// ---- exercise every path ----
console.log('exercising:');
await tx('approve WETH -> eWETH', { address: weth, abi: erc20Abi, functionName: 'approve', args: [eWeth, maxUint256] });
await tx('deposit 10 WETH', { address: eWeth, abi: vaultAbi, functionName: 'deposit', args: [parseEther('10'), user] });
await tx('enable eWETH as collateral', { address: evc, abi: evcAbi, functionName: 'enableCollateral', args: [user, eWeth] });
await tx('enable eUSDC as controller', { address: evc, abi: evcAbi, functionName: 'enableController', args: [user, eUsdc] });
await tx('borrow 5,000 USDC', { address: eUsdc, abi: vaultAbi, functionName: 'borrow', args: [5_000n * 10n ** 6n, user] });
const liqAfterBorrow = await liquidity(); const posAfterBorrow = await position();
await sim.provider.request({ method: 'evm_increaseTime', params: [3600] }); await sim.mine(1);
const liqAfterHour = await liquidity(); const posAfterHour = await position();
await tx('approve USDC -> eUSDC', { address: usdc, abi: erc20Abi, functionName: 'approve', args: [eUsdc, maxUint256] });
await tx('repay 1,000 USDC', { address: eUsdc, abi: vaultAbi, functionName: 'repay', args: [1_000n * 10n ** 6n, user] });
await tx('withdraw 1 WETH', { address: eWeth, abi: vaultAbi, functionName: 'withdraw', args: [parseEther('1'), user, user] });
await sim.deal(usdc, user, 10_000n * 10n ** 6n);   // interest accrued: the user needs more USDC than was borrowed (also warms USDC's balance slot for the scenario)
await tx('repay all', { address: eUsdc, abi: vaultAbi, functionName: 'repay', args: [maxUint256, user] });
await tx('disable controller', { address: eUsdc, abi: vaultAbi, functionName: 'disableController', args: [] });
const maxW = await read(eWeth, vaultAbi, 'maxWithdraw', [user]);
await tx('withdraw all WETH', { address: eWeth, abi: vaultAbi, functionName: 'withdraw', args: [maxW, user, user] });
await tx('disable collateral', { address: evc, abi: evcAbi, functionName: 'disableCollateral', args: [user, eWeth] });
await position(); await market();
const expected = { ltvBorrow: m[0], ltvLiquidation: m[1], afterBorrow: { collateralValue: liqAfterBorrow[0].toString(), liabilityValue: liqAfterBorrow[1].toString(), debt: posAfterBorrow[2].toString(), shares: posAfterBorrow[0].toString() }, afterHour: { liabilityValue: liqAfterHour[1].toString(), debt: posAfterHour[2].toString() } };
console.log('after borrow:', { collateralUsd: formatUnits(liqAfterBorrow[0], 18), liabilityUsd: formatUnits(liqAfterBorrow[1], 18), debt: formatUnits(posAfterBorrow[2], 6) }, 'debt after 1h:', formatUnits(posAfterHour[2], 6));

await sim.revert(clean);
const dump = await sim.dumpState();
const fixture = { source: `Euler V2, Ethereum mainnet fork at block ${blockNumber}, recorded ${new Date().toISOString()} via ${RPC}`, blockNumber, addresses: { ...EULER, user }, expected, remoteReads: { accounts: Object.keys(dump.remote.accounts).length, code: Object.keys(dump.remote.code).length, storage: Object.keys(dump.remote.storage).length }, dump };
writeFileSync(new URL('./fixtures/euler-mainnet.json', import.meta.url), JSON.stringify(fixture));
console.log(`recorded ${fixture.remoteReads.accounts} accounts, ${fixture.remoteReads.code} code blobs, ${fixture.remoteReads.storage} slots in ${Date.now() - t0} ms (${(JSON.stringify(fixture).length / 1024).toFixed(0)} KB) -> examples/euler/fixtures/euler-mainnet.json\nPASS`);
