// End-to-end in real Chromium: the dapp is the PLAIN production build (VITE_TERRARIUM=off — not one byte of simulator
// in it). The Terrarium is injected into the page by Playwright, exactly like a wallet extension would be, and the dapp
// discovers "Terrarium Wallet" through EIP-6963. A user adds liquidity to the real Uniswap V2 pool, hits every kind of
// failure a wallet and a chain can throw at a frontend, swaps, snapshots and reverts, removes liquidity, reloads and
// finds everything still there, then watches other actors trade.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';

const PORT = 4173;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe', env: { ...process.env, VITE_TERRARIUM: 'off' } });
await new Promise((res, rej) => { server.stdout.on('data', (d) => d.toString().includes('http') && res()); server.stderr.on('data', (d) => process.stderr.write(d)); setTimeout(() => rej(new Error('preview did not start')), 20000); });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.addInitScript({ path: 'dist-terrarium/terrarium.js' });   // <- the whole simulated chain, wallet and dev bar
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('[console]', m.text()); });
const results = {};
const t0 = Date.now();
const status = () => page.getByTestId('status').innerText();
const statusIs = (re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-testid=status]')?.innerText ?? ''), re.source, { timeout: 20000 });
const rpc = (method, params = []) => page.evaluate(([m, p]) => window.terrarium.request(m, p), [method, params]);
const price = () => page.getByTestId('price').innerText();
const points = async () => Number(await page.getByTestId('chart').getAttribute('data-points'));
const headBlock = async () => (await page.getByTestId('chain').innerText()).match(/block #(\d+)/)[1];   // the dapp's own view of the head
try {
  results.dappBundleIsPlain = !readdirSync('dist/assets').some((f) => /terrarium|worker/.test(f));
  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.getByTestId('price').waitFor({ timeout: 30000 });
  results.bootMs = Date.now() - t0;
  results.priceAtOpen = await price();
  results.pointsAtOpen = await points();
  const st = await rpc('terrarium_status');
  results.poolIsRealUniswapV2 = st.addresses.router.toLowerCase() === '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';

  // connect through the dapp's own EIP-6963 wallet picker
  await page.getByTestId('connect').click();
  await page.getByTestId('wallet-dev.terrarium').click();
  await page.getByTestId('account').waitFor();
  results.account = await page.getByTestId('account').innerText();
  results.balancesBefore = await page.getByTestId('balances').innerText();

  // add liquidity on both legs: type the ETH leg, the PEPE leg follows the pool ratio
  await page.getByTestId('tab-add').click();
  await page.getByTestId('add-eth').fill('2');
  await page.waitForFunction(() => Number(document.querySelector('[data-testid=add-pepe]').value) > 0);
  results.pepeLegAutoFilled = await page.getByTestId('add-pepe').inputValue();
  await page.getByTestId('add-submit').click();                       // "Approve PEPE" (spender: the router)
  await statusIs(/Approve PEPE\s+confirmed/);
  await page.getByTestId('add-submit').click();                       // "Add liquidity" (router.addLiquidityETH)
  await statusIs(/Add liquidity\s+confirmed/);
  results.addLiquidity = await status();
  results.position = await page.getByTestId('position').innerText();

  // no funds: our PEPE vanishes behind the UI's back; the UI still believes we hold PEPE, so the tx reaches the chain.
  // The REAL router's TransferHelper swallows the token's error and reverts with its own reason — and that is what a
  // user must see, decoded.
  await rpc('sim_deal', [st.addresses.token, st.accounts[0], '0x0']);
  const legBefore = await page.getByTestId('add-pepe').inputValue();
  await page.getByTestId('add-eth').fill('1');
  await page.waitForFunction((prev) => { const v = document.querySelector('[data-testid=add-pepe]').value; return Number(v) > 0 && v !== prev; }, legBefore);
  await page.getByTestId('add-submit').click();
  await statusIs(/Add liquidity\s+failed/);
  results.noFundsError = (await status()).replace(/\s+/g, ' ');
  await rpc('evm_mine');                                             // the UI catches up: the guard now stops it before any tx
  await page.waitForFunction(() => document.querySelector('[data-testid=add-submit]').disabled);
  results.noFundsGuard = await page.locator('label:has([data-testid=add-pepe]) small').innerText();
  await rpc('sim_deal', [st.addresses.token, st.accounts[0], '0x' + (50_000_000n * 10n ** 18n).toString(16)]);
  await rpc('evm_mine');
  await page.waitForFunction(() => !document.querySelector('[data-testid=add-submit]').disabled);

  // the wallet says no: arm a rejection in the dev bar, try to swap
  await page.getByTestId('tab-swap').click();
  await page.getByTestId('swap-amount').fill('1');
  await page.waitForFunction(() => document.querySelector('[data-testid=swap-out]').innerText !== '–');
  results.quote = { out: await page.getByTestId('swap-out').innerText(), impact: await page.getByTestId('impact').innerText() };
  await page.getByTestId('reject-next').click();
  await page.waitForFunction(() => /armed/.test(document.querySelector('[data-testid=reject-next]').innerText));
  await page.getByTestId('swap-submit').click();
  await statusIs(/Swap ETH for PEPE\s+failed/);
  results.rejectedError = (await status()).replace(/\s+/g, ' ');

  // the wallet is slow: 2 s to answer, the UI must show the pending state and then confirm
  await page.getByTestId('wallet-latency').click();
  await page.waitForFunction(() => /delay/.test(document.querySelector('[data-testid=wallet-latency]').innerText));
  const tSlow = Date.now();
  await page.getByTestId('swap-submit').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=status]')?.dataset.state === 'pending');
  await statusIs(/Swap ETH for PEPE\s+confirmed/);
  results.slowWalletMs = Date.now() - tSlow;
  await page.getByTestId('wallet-latency').click();
  await page.waitForFunction(() => /instant/.test(document.querySelector('[data-testid=wallet-latency]').innerText));
  await page.waitForFunction((p) => Number(document.querySelector('[data-testid=chart]').getAttribute('data-points')) > p, results.pointsAtOpen + 1);
  results.priceAfterSwap = await price();
  results.pointsAfterSwap = await points();
  results.firstActivityRow = (await page.getByTestId('activity').locator('li').first().innerText()).replace(/\s+/g, ' ');

  // swap back the other way (the router allowance is already MAX from the approval above)
  await page.getByTestId('swap-flip').click();
  await page.getByTestId('swap-amount').fill('200000');
  await page.waitForFunction(() => document.querySelector('[data-testid=swap-out]').innerText !== '–');
  await page.getByTestId('swap-submit').click();
  await statusIs(/Swap PEPE for ETH\s+confirmed/);
  results.priceAfterSwapBack = await price();
  const pointsBeforeSnapshot = await points();

  // snapshot, swap, revert: chain AND UI history must come back
  await page.getByTestId('snapshot').click();
  await page.waitForFunction(() => /Revert/.test(document.querySelector('[data-testid=snapshot]').innerText));
  await page.getByTestId('swap-flip').click();
  await page.getByTestId('swap-amount').fill('1');
  await page.waitForFunction(() => document.querySelector('[data-testid=swap-out]').innerText !== '–');
  await page.getByTestId('swap-submit').click();
  await statusIs(/Swap ETH for PEPE\s+confirmed/);
  results.priceInsideSnapshot = await price();
  await page.getByTestId('snapshot').click();                          // revert
  await page.waitForFunction(([p, n]) => document.querySelector('[data-testid=price]').innerText === p && Number(document.querySelector('[data-testid=chart]').getAttribute('data-points')) === n, [results.priceAfterSwapBack, pointsBeforeSnapshot], { timeout: 15000 });
  results.priceAfterRevert = await price();
  results.pointsAfterRevert = await points();

  // remove half the position: the router needs an allowance on the LP tokens first
  await page.getByTestId('tab-remove').click();
  results.removePreview = await page.getByTestId('remove-out').innerText();
  await page.getByTestId('remove-submit').click();                      // "Approve LP tokens"
  await statusIs(/Approve LP tokens\s+confirmed/);
  await page.getByTestId('remove-submit').click();                      // "Remove liquidity"
  await statusIs(/Remove liquidity\s+confirmed/);
  results.positionAfterRemove = await page.getByTestId('position').innerText();
  results.blockBeforeReload = await headBlock();
  results.balancesAfter = await page.getByTestId('balances').innerText();
  await page.screenshot({ path: 'e2e/frogpond.png', fullPage: true });

  // reload: the chain (IndexedDB, inside the Worker), the pool and the history come back
  const t1 = Date.now();
  await page.reload();
  await page.getByTestId('price').waitFor({ timeout: 30000 });
  await page.waitForFunction((n) => document.querySelector('[data-testid=activity] li:nth-child(' + n + ')'), 1);
  results.reloadMs = Date.now() - t1;
  results.priceAfterReload = await price();
  results.pointsAfterReload = await points();
  results.blockAfterReload = await headBlock();
  results.activityRowsAfterReload = await page.getByTestId('activity').locator('li').count();

  // pond life: other actors trade on their own inside the Worker (no human action)
  const before = await points();
  await page.getByTestId('actors').click();
  await page.waitForFunction((p) => Number(document.querySelector('[data-testid=chart]').getAttribute('data-points')) > p, before, { timeout: 25000 });
  results.pondLifeRow = (await page.getByTestId('activity').locator('li').first().innerText()).replace(/\s+/g, ' ');
  await page.getByTestId('actors').click(); // off again so the next run is deterministic
  await page.waitForFunction(() => /off/.test(document.querySelector('[data-testid=actors]').innerText));
  results.totalMs = Date.now() - t0;
  console.log(JSON.stringify(results, null, 2));
  const ok = results.dappBundleIsPlain && results.poolIsRealUniswapV2
    && /confirmed/.test(results.addLiquidity) && /16\.67%/.test(results.position)
    && /TransferHelper: TRANSFER_FROM_FAILED/.test(results.noFundsError) && /not enough/.test(results.noFundsGuard)
    && /rejected the request/.test(results.rejectedError) && results.slowWalletMs >= 2000
    && results.pointsAfterSwap > results.pointsAtOpen && results.priceAfterSwap !== results.priceAtOpen
    && results.priceInsideSnapshot !== results.priceAfterSwapBack && results.priceAfterRevert === results.priceAfterSwapBack && results.pointsAfterRevert === pointsBeforeSnapshot
    && /9\.09%/.test(results.positionAfterRemove)
    && results.priceAfterReload === results.priceAfterSwapBack && results.blockAfterReload === results.blockBeforeReload;
  console.log(ok ? '\nPASS' : '\nFAIL');
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.error('E2E error:', e.message);
  console.error('progress so far:', JSON.stringify(results, null, 2));
  console.error('status now:', await status().catch(() => 'n/a'));
  await page.screenshot({ path: 'e2e/failure.png', fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
