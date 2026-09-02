// examples/aave/record.mjs — RECORD the Aave V3 mainnet state this example needs into an offline fixture (needs network).
// Forks mainnet, deals the user WETH, then exercises every path the UI and the test will take (supply, borrow, time
// passing, repay, withdraw, oracle reads) so all the state they touch is recorded. The user's position is rolled back
// with a snapshot before dumping: the fixture starts clean (100 WETH, nothing supplied) but complete.
//   npm run record:aave          (FORK_RPC=https://... for another endpoint)
import { writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, custom, defineChain, formatUnits, maxUint256, parseEther } from 'viem';
import { createTerrarium } from 'terrarium/engine';
import { AAVE, poolAbi, providerAbi, oracleAbi, erc20Abi } from './src/protocol.ts';

const RPC = process.env.FORK_RPC ?? 'https://ethereum-rpc.publicnode.com';
const remote = async (method, params) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result;
const blockNumber = Number(await remote('eth_blockNumber', [])) - 8;
console.log(`forking mainnet at block ${blockNumber} via ${RPC}`);
const t0 = Date.now();
const sim = await createTerrarium({ chainId: 1, fork: { url: RPC, blockNumber }, seed: 1 });
const chain = defineChain({ id: 1, name: 'mainnet-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
const pub = createPublicClient({ chain, transport: custom(sim.provider), pollingInterval: 20 });
const user = sim.accounts[0].address;
const w = createWalletClient({ chain, transport: custom(sim.provider), account: user });
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const tx = async (label, req) => {
  try { const r = await pub.waitForTransactionReceipt({ hash: await w.writeContract(req) }); if (r.status !== 'success') throw new Error(`${label} reverted on-chain`); console.log(`  ${label}: ${r.gasUsed} gas`); return r; }
  catch (e) { const rev = e.walk?.((x) => x?.name === 'ContractFunctionRevertedError'); console.error(`  ${label} FAILED: ${rev?.reason ?? rev?.data?.errorName ?? e.shortMessage ?? e.message}`); throw e; }
};
const { pool, weth, usdc } = AAVE;

// ---- discover + warm up every read the UI does ----
const provider = await read(pool, poolAbi, 'ADDRESSES_PROVIDER');
const oracle = await read(provider, providerAbi, 'getPriceOracle');
const [wethReserve, usdcReserve] = await Promise.all([read(pool, poolAbi, 'getReserveData', [weth]), read(pool, poolAbi, 'getReserveData', [usdc])]);
const aWeth = wethReserve.aTokenAddress, vDebtUsdc = usdcReserve.variableDebtTokenAddress;
const [ethPrice, usdcPrice, ethSource, baseUnit] = await Promise.all([read(oracle, oracleAbi, 'getAssetPrice', [weth]), read(oracle, oracleAbi, 'getAssetPrice', [usdc]), read(oracle, oracleAbi, 'getSourceOfAsset', [weth]), read(oracle, oracleAbi, 'BASE_CURRENCY_UNIT')]);
for (const t of [weth, usdc, aWeth, vDebtUsdc]) await Promise.all([read(t, erc20Abi, 'decimals'), read(t, erc20Abi, 'symbol')]);
const account = () => read(pool, poolAbi, 'getUserAccountData', [user]);
const balances = () => Promise.all([read(weth, erc20Abi, 'balanceOf', [user]), read(usdc, erc20Abi, 'balanceOf', [user]), read(aWeth, erc20Abi, 'balanceOf', [user]), read(vDebtUsdc, erc20Abi, 'balanceOf', [user]), read(weth, erc20Abi, 'allowance', [user, pool]), read(usdc, erc20Abi, 'allowance', [user, pool])]);
console.log({ pool, oracle, aWeth, vDebtUsdc, ethSource, ethPrice: formatUnits(ethPrice, 8), usdcPrice: formatUnits(usdcPrice, 8), wethSupplyApr: (Number(wethReserve.currentLiquidityRate) / 1e25).toFixed(2) + '%', usdcBorrowApr: (Number(usdcReserve.currentVariableBorrowRate) / 1e25).toFixed(2) + '%' });
// the fixed price feed the scenario can install at the ETH source reads slots 0..2 of that address: record them
for (const slot of ['0x0', '0x1', '0x2']) await sim.provider.request({ method: 'eth_getStorageAt', params: [ethSource, slot, 'latest'] });

// ---- the user: 100 WETH, then a clean snapshot ----
await sim.deal(weth, user, parseEther('100'));
await account(); await balances();
const clean = await sim.snapshot();

// ---- exercise every path (this is what gets recorded) ----
console.log('exercising:');
await tx('approve WETH', { address: weth, abi: erc20Abi, functionName: 'approve', args: [pool, maxUint256] });
await tx('supply 10 WETH', { address: pool, abi: poolAbi, functionName: 'supply', args: [weth, parseEther('10'), user, 0] });
await tx('borrow 5,000 USDC', { address: pool, abi: poolAbi, functionName: 'borrow', args: [usdc, 5_000n * 10n ** 6n, 2n, 0, user] });
const afterBorrow = await account(); const balAfterBorrow = await balances();
await sim.provider.request({ method: 'evm_increaseTime', params: [3600] }); await sim.mine(1);
const afterHour = await account(); const balAfterHour = await balances();
await tx('approve USDC', { address: usdc, abi: erc20Abi, functionName: 'approve', args: [pool, maxUint256] });
await tx('repay 1,000 USDC', { address: pool, abi: poolAbi, functionName: 'repay', args: [usdc, 1_000n * 10n ** 6n, 2n, user] });
await tx('withdraw 1 WETH', { address: pool, abi: poolAbi, functionName: 'withdraw', args: [weth, parseEther('1'), user] });
await sim.deal(usdc, user, 10_000n * 10n ** 6n);   // interest accrued: the user needs more USDC than was borrowed (also warms USDC's balance slot for the scenario)
await tx('repay all USDC', { address: pool, abi: poolAbi, functionName: 'repay', args: [usdc, maxUint256, 2n, user] });
await tx('withdraw all WETH', { address: pool, abi: poolAbi, functionName: 'withdraw', args: [weth, maxUint256, user] });
await account(); await balances();
const expected = { ethPrice: ethPrice.toString(), usdcPrice: usdcPrice.toString(), baseUnit: baseUnit.toString(), afterBorrow: { healthFactor: afterBorrow[5].toString(), totalCollateralBase: afterBorrow[0].toString(), totalDebtBase: afterBorrow[1].toString(), ltv: afterBorrow[4].toString(), liquidationThreshold: afterBorrow[3].toString(), debt: balAfterBorrow[3].toString(), aWeth: balAfterBorrow[2].toString() }, afterHour: { healthFactor: afterHour[5].toString(), debt: balAfterHour[3].toString(), aWeth: balAfterHour[2].toString() } };
console.log('after borrow:', { hf: formatUnits(afterBorrow[5], 18), collateralUsd: formatUnits(afterBorrow[0], 8), debtUsd: formatUnits(afterBorrow[1], 8) }, 'debt after 1h:', formatUnits(balAfterHour[3], 6), 'USDC');

// ---- back to clean, dump ----
await sim.revert(clean);
const dump = await sim.dumpState();
const fixture = { source: `Aave V3, Ethereum mainnet fork at block ${blockNumber}, recorded ${new Date().toISOString()} via ${RPC}`, blockNumber, addresses: { ...AAVE, provider, oracle, aWeth, vDebtUsdc, ethSource, user }, expected, remoteReads: { accounts: Object.keys(dump.remote.accounts).length, code: Object.keys(dump.remote.code).length, storage: Object.keys(dump.remote.storage).length }, dump };
writeFileSync(new URL('./fixtures/aave-mainnet.json', import.meta.url), JSON.stringify(fixture));
console.log(`recorded ${fixture.remoteReads.accounts} accounts, ${fixture.remoteReads.code} code blobs, ${fixture.remoteReads.storage} slots in ${Date.now() - t0} ms (${(JSON.stringify(fixture).length / 1024).toFixed(0)} KB) -> examples/aave/fixtures/aave-mainnet.json\nPASS`);
