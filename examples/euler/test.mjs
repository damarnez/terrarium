// examples/euler/test.mjs — offline replay on the recorded Euler V2 fork (network forbidden): deposit, enable collateral
// and controller, borrow, check the vault's risk-adjusted liquidity against the UI's math, accrue an hour of interest,
// repay, disable, withdraw.
//   node examples/euler/test.mjs            TERRARIUM_ENGINE=revm node examples/euler/test.mjs
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, custom, defineChain, formatUnits, maxUint256, parseEther } from 'viem';
import { createTerrarium } from 'terrarium/engine';
import { EULER, vaultAbi, evcAbi, erc20Abi } from './src/protocol.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/euler-mainnet.json', import.meta.url), 'utf8'));
const { evc, eWeth, eUsdc, weth, usdc, user } = fixture.addresses;
const engine = process.env.TERRARIUM_ENGINE ?? 'js';
let networkAttempts = 0; globalThis.fetch = async (url) => { networkAttempts++; throw new Error(`offline: ${url}`); };
// Chainlink adapters revert with PriceOracle_TooStale once the recorded round is older than their limit: with a wall
// clock this fixture would rot. Anchor the chain clock to the recording; time still advances via evm_increaseTime.
const anchor = Number(BigInt(fixture.dump.chain.blocks.at(-1).timestamp));
const t0 = Date.now();
const sim = await createTerrarium({ chainId: 1, engine, fork: { blockNumber: fixture.blockNumber, offline: true }, restore: fixture.dump, seed: 1, clock: () => anchor });
const chain = defineChain({ id: 1, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
const pub = createPublicClient({ chain, transport: custom(sim.provider), pollingInterval: 20 });
const w = createWalletClient({ chain, transport: custom(sim.provider), account: user });
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const tx = async (req) => { const r = await pub.waitForTransactionReceipt({ hash: await w.writeContract(req) }); if (r.status !== 'success') throw new Error(`${req.functionName} reverted`); return r; };
const out = { engine, restoredMs: Date.now() - t0 };

const ltv = await read(eUsdc, vaultAbi, 'LTVBorrow', [eWeth]);
await tx({ address: weth, abi: erc20Abi, functionName: 'approve', args: [eWeth, maxUint256] });
await tx({ address: eWeth, abi: vaultAbi, functionName: 'deposit', args: [parseEther('10'), user] });
await tx({ address: evc, abi: evcAbi, functionName: 'enableCollateral', args: [user, eWeth] });
await tx({ address: evc, abi: evcAbi, functionName: 'enableController', args: [user, eUsdc] });
await tx({ address: eUsdc, abi: vaultAbi, functionName: 'borrow', args: [5_000n * 10n ** 6n, user] });
const [collateralValue, liabilityValue] = await read(eUsdc, vaultAbi, 'accountLiquidity', [user, false]);
const shares = await read(eWeth, vaultAbi, 'balanceOf', [user]), assets = await read(eWeth, vaultAbi, 'convertToAssets', [shares]), debt = await read(eUsdc, vaultAbi, 'debtOf', [user]);
out.afterBorrow = { ltvBorrow: ltv / 100 + '%', collateralUsd: formatUnits(collateralValue, 18), liabilityUsd: formatUnits(liabilityValue, 18), depositedWeth: formatUnits(assets, 18), debt: formatUnits(debt, 6), controllers: await read(evc, evcAbi, 'getControllers', [user]), collaterals: await read(evc, evcAbi, 'getCollaterals', [user]) };
// what the UI shows as "borrowing power used": liability / risk-adjusted collateral
out.afterBorrow.powerUsedPct = Number(liabilityValue * 10000n / collateralValue) / 100;
// the collateral value carries the deposit's accrued interest, so it moves with the block timestamp: compare within 1e-6
const rel = (x, y) => Math.abs(Number(x) - Number(y)) / Number(y);
out.matchesRecording = rel(collateralValue, fixture.expected.afterBorrow.collateralValue) < 1e-6 && liabilityValue.toString() === fixture.expected.afterBorrow.liabilityValue;

// an hour passes: the debt grows (debtOf needs no oracle). Anything that prices collateral now reverts with
// PriceOracle_TooStale: the recorded Chainlink round is older than the adapter allows. Exactly what a mainnet fork does.
await sim.provider.request({ method: 'evm_increaseTime', params: [3600] }); await sim.mine(1);
const debt1h = await read(eUsdc, vaultAbi, 'debtOf', [user]);
const stale = await read(eUsdc, vaultAbi, 'accountLiquidity', [user, false]).then(() => null, (e) => e.walk?.((x) => x?.name === 'ContractFunctionRevertedError')?.signature ?? 'reverted');
out.afterHour = { debt: formatUnits(debt1h, 6), debtGrew: debt1h > 5_000n * 10n ** 6n, oracleAfterAnHour: stale === '0xa6e68d63' ? 'PriceOracle_TooStale (as on a real fork)' : stale ?? 'fresh' };
// back to the recorded moment for the rest: the oracle is fresh again
await sim.provider.request({ method: 'evm_increaseTime', params: [-3600] }); await sim.mine(1);

await sim.deal(usdc, user, 10_000n * 10n ** 6n);
await tx({ address: usdc, abi: erc20Abi, functionName: 'approve', args: [eUsdc, maxUint256] });
await tx({ address: eUsdc, abi: vaultAbi, functionName: 'repay', args: [maxUint256, user] });
await tx({ address: eUsdc, abi: vaultAbi, functionName: 'disableController', args: [] });
const maxW = await read(eWeth, vaultAbi, 'maxWithdraw', [user]);
await tx({ address: eWeth, abi: vaultAbi, functionName: 'withdraw', args: [maxW, user, user] });
out.closed = { debt: formatUnits(await read(eUsdc, vaultAbi, 'debtOf', [user]), 6), controllers: await read(evc, evcAbi, 'getControllers', [user]), weth: formatUnits(await read(weth, erc20Abi, 'balanceOf', [user]), 18) };
out.networkAttempts = networkAttempts; out.offlineMisses = sim.offlineMisses; out.totalMs = Date.now() - t0;
console.log(JSON.stringify(out, null, 2));
const ok = out.matchesRecording && out.afterHour.debtGrew && out.closed.debt === '0' && out.closed.controllers.length === 0 && networkAttempts === 0 && out.offlineMisses.length === 0;
console.log(ok ? '\nPASS' : '\nFAIL'); process.exit(ok ? 0 : 1);
