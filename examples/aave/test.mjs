// examples/aave/test.mjs — offline replay on the recorded Aave V3 fork: the network is forbidden (fork.offline), every read
// must come from the fixture. Checks the UI's math against the real Pool: health factor, interest over an hour, and a
// price shock through a fixed price feed installed at the Chainlink source address.
//   node examples/aave/test.mjs            TERRARIUM_ENGINE=revm node examples/aave/test.mjs
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, custom, defineChain, formatUnits, maxUint256, parseEther } from 'viem';
import { createTerrarium } from 'terrarium/engine';
import { AAVE, poolAbi, oracleAbi, erc20Abi } from './src/protocol.ts';
import { FixedPriceFeed } from './src/generated/contracts.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/aave-mainnet.json', import.meta.url), 'utf8'));
const { pool, weth, usdc, oracle, aWeth, vDebtUsdc, ethSource, user } = fixture.addresses;
const engine = process.env.TERRARIUM_ENGINE ?? 'js';
let networkAttempts = 0; globalThis.fetch = async (url) => { networkAttempts++; throw new Error(`offline: ${url}`); };
const t0 = Date.now();
const sim = await createTerrarium({ chainId: 1, engine, fork: { blockNumber: fixture.blockNumber, offline: true }, restore: fixture.dump, seed: 1 });
const chain = defineChain({ id: 1, name: 'fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [] } } });
const pub = createPublicClient({ chain, transport: custom(sim.provider), pollingInterval: 20 });
const w = createWalletClient({ chain, transport: custom(sim.provider), account: user });
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const tx = async (req) => { const r = await pub.waitForTransactionReceipt({ hash: await w.writeContract(req) }); if (r.status !== 'success') throw new Error(`${req.functionName} reverted`); return r; };
const account = async () => { const [collateral, debt, available, liqThreshold, ltv, hf] = await read(pool, poolAbi, 'getUserAccountData', [user]); return { collateral, debt, available, liqThreshold, ltv, hf }; };
/** what the UI computes: HF = collateral × liquidation threshold / debt (base currency, 8 decimals; thresholds in bps) */
const clientHf = (a) => (a.debt === 0n ? Infinity : Number(a.collateral * a.liqThreshold) / 10000 / Number(a.debt));
const out = { engine, restoredMs: Date.now() - t0 };

out.startWeth = formatUnits(await read(weth, erc20Abi, 'balanceOf', [user]), 18);
await tx({ address: weth, abi: erc20Abi, functionName: 'approve', args: [pool, maxUint256] });
await tx({ address: pool, abi: poolAbi, functionName: 'supply', args: [weth, parseEther('10'), user, 0] });
await tx({ address: pool, abi: poolAbi, functionName: 'borrow', args: [usdc, 5_000n * 10n ** 6n, 2n, 0, user] });
const a1 = await account();
out.afterBorrow = { healthFactorContract: Number(a1.hf) / 1e18, healthFactorClient: clientHf(a1), collateralUsd: formatUnits(a1.collateral, 8), debtUsd: formatUnits(a1.debt, 8), aWeth: formatUnits(await read(aWeth, erc20Abi, 'balanceOf', [user]), 18), debt: formatUnits(await read(vDebtUsdc, erc20Abi, 'balanceOf', [user]), 6) };
out.hfMatchesClientMath = Math.abs(out.afterBorrow.healthFactorContract - out.afterBorrow.healthFactorClient) < 1e-6;
out.hfMatchesRecording = Math.abs(out.afterBorrow.healthFactorContract - Number(fixture.expected.afterBorrow.healthFactor) / 1e18) < 1e-3;

// an hour passes: the debt grows, the supplied aWETH grows
await sim.provider.request({ method: 'evm_increaseTime', params: [3600] }); await sim.mine(1);
const debt1h = await read(vDebtUsdc, erc20Abi, 'balanceOf', [user]), aWeth1h = await read(aWeth, erc20Abi, 'balanceOf', [user]);
out.afterHour = { debt: formatUnits(debt1h, 6), aWeth: formatUnits(aWeth1h, 18), debtGrew: debt1h > 5_000n * 10n ** 6n, aWethGrew: aWeth1h > parseEther('10') };

// price shock: a fixed feed at the Chainlink source address, ETH −50 %
const price0 = await read(oracle, oracleAbi, 'getAssetPrice', [weth]);
await sim.provider.request({ method: 'anvil_setCode', params: [ethSource, FixedPriceFeed.deployedBytecode] });
await sim.setState(ethSource, FixedPriceFeed.storageLayout, { answer: price0 / 2n, decimals: 8, roundId: 1 });
const price1 = await read(oracle, oracleAbi, 'getAssetPrice', [weth]);
const a2 = await account();
out.priceShock = { before: formatUnits(price0, 8), after: formatUnits(price1, 8), oracleFollowsFeed: price1 === price0 / 2n, healthFactor: Number(a2.hf) / 1e18, roughlyHalved: Math.abs(Number(a2.hf) / 1e18 - out.afterBorrow.healthFactorContract / 2) / (out.afterBorrow.healthFactorContract / 2) < 0.02, stillMatchesClientMath: Math.abs(Number(a2.hf) / 1e18 - clientHf(a2)) < 1e-6 };

// repay everything (interest needs a little more USDC than was borrowed) and withdraw
await sim.deal(usdc, user, 10_000n * 10n ** 6n);
await tx({ address: usdc, abi: erc20Abi, functionName: 'approve', args: [pool, maxUint256] });
await tx({ address: pool, abi: poolAbi, functionName: 'repay', args: [usdc, maxUint256, 2n, user] });
await tx({ address: pool, abi: poolAbi, functionName: 'withdraw', args: [weth, maxUint256, user] });
const a3 = await account();
out.closed = { debtUsd: formatUnits(a3.debt, 8), collateralUsd: formatUnits(a3.collateral, 8), weth: formatUnits(await read(weth, erc20Abi, 'balanceOf', [user]), 18) };
out.networkAttempts = networkAttempts; out.offlineMisses = sim.offlineMisses; out.totalMs = Date.now() - t0;
console.log(JSON.stringify(out, null, 2));
const ok = out.hfMatchesClientMath && out.hfMatchesRecording && out.afterHour.debtGrew && out.afterHour.aWethGrew && out.priceShock.oracleFollowsFeed && out.priceShock.roughlyHalved && out.priceShock.stillMatchesClientMath && a3.debt === 0n && networkAttempts === 0 && out.offlineMisses.length === 0;
console.log(ok ? '\nPASS' : '\nFAIL'); process.exit(ok ? 0 : 1);
