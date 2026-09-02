import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, custom, defineChain, formatUnits, maxUint256, type Address, type EIP1193Provider, type Hex } from 'viem';
import { useWallets, type WalletDetail } from './wallet';
import { WalletButton } from './WalletButton';
import { poolAbi, providerAbi, oracleAbi, erc20Abi, aprPercent } from './protocol';
import { fmt, usd, parseAmount, short } from './format';

export interface Config { pool: Address; weth: Address; usdc: Address; chainId: number }
type Tab = 'supply' | 'borrow' | 'repay' | 'withdraw';
type TxState = { status: 'idle' } | { status: 'pending'; label: string } | { status: 'confirmed'; label: string; hash: Hex } | { status: 'failed'; label: string; error: string };
interface Market { oracle: Address; aWeth: Address; vDebtUsdc: Address; ethPrice: bigint; usdcPrice: bigint; supplyApr: number; borrowApr: number; usdcAvailable: bigint }
interface Position { collateral: bigint; debt: bigint; available: bigint; liqThreshold: bigint; ltv: bigint; hf: bigint; aWeth: bigint; debtUsdc: bigint; weth: bigint; usdc: bigint; wethAllowance: bigint; usdcAllowance: bigint }

const explain = (e: unknown) => { if (e instanceof BaseError) { const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null; if (r?.reason) return r.reason; if (r?.data) return `${r.data.errorName}(${(r.data.args ?? []).map(String).join(', ')})`; if (/rejected/i.test(e.shortMessage)) return 'You rejected the request in your wallet'; return e.shortMessage; } return String(e); };
/** the UI's own health-factor math (Aave: Σ collateral × liquidation threshold / debt), in base currency (8 decimals) */
const healthFactor = (collateralBase: bigint, liqThresholdBps: bigint, debtBase: bigint) => (debtBase === 0n ? Infinity : Number(collateralBase * liqThresholdBps) / 10000 / Number(debtBase));
const hfClass = (hf: number) => (hf === Infinity || hf > 2 ? 'ok' : hf > 1.1 ? 'warn' : 'danger');

export function App({ config }: { config: Config }) {
  const wallets = useWallets();
  const [wallet, setWallet] = useState<WalletDetail | null>(null);
  const [accounts, setAccounts] = useState<Address[]>([]);
  const [account, setAccount] = useState<Address | null>(null);
  const readProvider: EIP1193Provider | null = wallet?.provider ?? wallets[0]?.provider ?? null;
  const chain = useMemo(() => defineChain({ id: config.chainId, name: 'Ethereum', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: import.meta.env.VITE_RPC_URL ? [import.meta.env.VITE_RPC_URL] : [] } } }), [config.chainId]);
  const pub = useMemo(() => (readProvider ? createPublicClient({ chain, transport: custom(readProvider), pollingInterval: 500 }) : null), [readProvider, chain]);
  const w = useMemo(() => (wallet && account ? createWalletClient({ chain, transport: custom(wallet.provider), account }) : null), [wallet, account, chain]);
  const [market, setMarket] = useState<Market | null>(null);
  const [pos, setPos] = useState<Position | null>(null);
  const [block, setBlock] = useState<{ number: bigint; timestamp: bigint } | null>(null);
  const [tx, setTx] = useState<TxState>({ status: 'idle' });
  const [tab, setTab] = useState<Tab>('supply');
  const [amount, setAmount] = useState('1');
  const marketRef = useRef<Market | null>(null);

  const refresh = useCallback(async () => {
    if (!pub) return;
    const { pool, weth, usdc } = config;
    let m = marketRef.current;
    if (!m) {
      const provider = await pub.readContract({ address: pool, abi: poolAbi, functionName: 'ADDRESSES_PROVIDER' });
      const oracle = await pub.readContract({ address: provider, abi: providerAbi, functionName: 'getPriceOracle' });
      const [wr, ur] = await Promise.all([pub.readContract({ address: pool, abi: poolAbi, functionName: 'getReserveData', args: [weth] }), pub.readContract({ address: pool, abi: poolAbi, functionName: 'getReserveData', args: [usdc] })]);
      m = { oracle, aWeth: wr.aTokenAddress, vDebtUsdc: ur.variableDebtTokenAddress, ethPrice: 0n, usdcPrice: 0n, supplyApr: 0, borrowApr: 0, usdcAvailable: 0n };
    }
    const [wr, ur, ethPrice, usdcPrice, b] = await Promise.all([
      pub.readContract({ address: pool, abi: poolAbi, functionName: 'getReserveData', args: [weth] }), pub.readContract({ address: pool, abi: poolAbi, functionName: 'getReserveData', args: [usdc] }),
      pub.readContract({ address: m.oracle, abi: oracleAbi, functionName: 'getAssetPrice', args: [weth] }), pub.readContract({ address: m.oracle, abi: oracleAbi, functionName: 'getAssetPrice', args: [usdc] }),
      pub.getBlock(),
    ]);
    const usdcAvailable = await pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [ur.aTokenAddress] });   // USDC sitting in aUSDC = liquidity to borrow
    m = { ...m, ethPrice, usdcPrice, supplyApr: aprPercent(wr.currentLiquidityRate), borrowApr: aprPercent(ur.currentVariableBorrowRate), usdcAvailable };
    marketRef.current = m; setMarket(m); setBlock({ number: b.number!, timestamp: b.timestamp });
    if (account) {
      const [[collateral, debt, available, liqThreshold, ltv, hf], aWeth, debtUsdc, wethBal, usdcBal, wethAllowance, usdcAllowance] = await Promise.all([
        pub.readContract({ address: pool, abi: poolAbi, functionName: 'getUserAccountData', args: [account] }),
        pub.readContract({ address: m.aWeth, abi: erc20Abi, functionName: 'balanceOf', args: [account] }), pub.readContract({ address: m.vDebtUsdc, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
        pub.readContract({ address: weth, abi: erc20Abi, functionName: 'balanceOf', args: [account] }), pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
        pub.readContract({ address: weth, abi: erc20Abi, functionName: 'allowance', args: [account, pool] }), pub.readContract({ address: usdc, abi: erc20Abi, functionName: 'allowance', args: [account, pool] }),
      ]);
      setPos({ collateral, debt, available, liqThreshold, ltv, hf, aWeth, debtUsdc, weth: wethBal, usdc: usdcBal, wethAllowance, usdcAllowance });
    } else setPos(null);
  }, [pub, account, config]);

  useEffect(() => { if (!pub) return; let last: bigint | null = null, stop = false; refresh().catch(() => {}); const t = setInterval(async () => { const n = await pub.getBlockNumber({ cacheTime: 0 }).catch(() => null); if (n === null || stop) return; if (last === null || n !== last) { last = n; refresh().catch(() => {}); } }, 500); return () => { stop = true; clearInterval(t); }; }, [pub, refresh]);
  useEffect(() => { if (!wallet) return; const on = (a: Address[]) => { setAccounts(a); setAccount(a[0] ?? null); }; wallet.provider.on('accountsChanged', on as any); return () => { wallet.provider.removeListener('accountsChanged', on as any); }; }, [wallet]);
  const connect = async (d: WalletDetail) => { const a = (await d.provider.request({ method: 'eth_requestAccounts' })) as Address[]; setWallet(d); setAccounts(a); setAccount(a[0] ?? null); };

  const run = async (label: string, fn: () => Promise<Hex>) => { if (!pub) return; setTx({ status: 'pending', label }); try { const hash = await fn(); const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error('Transaction reverted on-chain'); setTx({ status: 'confirmed', label, hash }); await refresh(); } catch (e) { setTx({ status: 'failed', label, error: explain(e) }); } };
  const { pool, weth, usdc } = config;
  const decimals = tab === 'supply' || tab === 'withdraw' ? 18 : 6;
  const amt = parseAmount(amount, decimals);
  const needsApproval = pos && amt ? (tab === 'supply' ? pos.wethAllowance < amt : tab === 'repay' ? pos.usdcAllowance < amt : false) : false;
  const submit = () => {
    if (!w || !amt || !account) return;
    if (needsApproval) return run(tab === 'supply' ? 'Approve WETH' : 'Approve USDC', () => w.writeContract({ address: tab === 'supply' ? weth : usdc, abi: erc20Abi, functionName: 'approve', args: [pool, maxUint256] }));
    if (tab === 'supply') return run('Supply WETH', () => w.writeContract({ address: pool, abi: poolAbi, functionName: 'supply', args: [weth, amt, account, 0] }));
    if (tab === 'borrow') return run('Borrow USDC', () => w.writeContract({ address: pool, abi: poolAbi, functionName: 'borrow', args: [usdc, amt, 2n, 0, account] }));
    if (tab === 'repay') return run('Repay USDC', () => w.writeContract({ address: pool, abi: poolAbi, functionName: 'repay', args: [usdc, amt, 2n, account] }));
    return run('Withdraw WETH', () => w.writeContract({ address: pool, abi: poolAbi, functionName: 'withdraw', args: [weth, amt, account] }));
  };

  // the UI's projection of the health factor after this action, in base currency (8 decimals) — compared with the Pool's answer after the tx
  const projected = (() => {
    if (!pos || !market || !amt) return null;
    const ethBase = (x: bigint) => (x * market.ethPrice) / 10n ** 18n, usdcBase = (x: bigint) => (x * market.usdcPrice) / 10n ** 6n;
    const c = tab === 'supply' ? pos.collateral + ethBase(amt) : tab === 'withdraw' ? pos.collateral - ethBase(amt) : pos.collateral;
    const d = tab === 'borrow' ? pos.debt + usdcBase(amt) : tab === 'repay' ? pos.debt - (usdcBase(amt) > pos.debt ? pos.debt : usdcBase(amt)) : pos.debt;
    return c < 0n ? 0 : healthFactor(c, pos.liqThreshold, d < 0n ? 0n : d);
  })();
  const hfContract = pos ? (pos.debt === 0n ? Infinity : Number(pos.hf) / 1e18) : null;
  const hfClient = pos ? healthFactor(pos.collateral, pos.liqThreshold, pos.debt) : null;
  const balance = pos ? (tab === 'supply' ? pos.weth : tab === 'borrow' ? pos.available : tab === 'repay' ? pos.usdc : pos.aWeth) : 0n;

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><div><h1>Aave V3</h1><p>supply WETH, borrow USDC · mainnet contracts</p></div></div>
        <div className="chainline" data-testid="chain">{block ? <><span className="dot-live" /> chain {config.chainId} · block #{block.number.toString()} · {new Date(Number(block.timestamp) * 1000).toLocaleTimeString()}</> : readProvider ? 'connecting to the chain…' : 'no wallet found'}</div>
        <WalletButton connected={wallet} accounts={accounts} account={account} onConnect={connect} onSelect={setAccount} onDisconnect={() => { setWallet(null); setAccounts([]); setAccount(null); }} />
      </header>
      <main className="grid">
        <section className="pond">
          {market ? (
            <dl className="stats" data-testid="market">
              <div><dt>ETH price (Aave oracle)</dt><dd data-testid="eth-price">{usd(Number(formatUnits(market.ethPrice, 8)))}</dd></div>
              <div><dt>WETH supply APR</dt><dd>{fmt(market.supplyApr, 2)}%</dd></div>
              <div><dt>USDC borrow APR (variable)</dt><dd>{fmt(market.borrowApr, 2)}%</dd></div>
              <div><dt>USDC available to borrow</dt><dd>{fmt(Number(formatUnits(market.usdcAvailable, 6)), 0)} USDC</dd></div>
              <div><dt>USDC price</dt><dd>{usd(Number(formatUnits(market.usdcPrice, 8)))}</dd></div>
              <div><dt>Pool</dt><dd title={pool}>{short(pool)}</dd></div>
            </dl>
          ) : <div className="stats stats-empty">Reading the market…</div>}
          <dl className="stats" data-testid="position">
            <div><dt>Supplied</dt><dd>{pos ? `${fmt(Number(formatUnits(pos.aWeth, 18)), 4)} WETH` : '–'}</dd></div>
            <div><dt>Borrowed</dt><dd>{pos ? `${fmt(Number(formatUnits(pos.debtUsdc, 6)), 2)} USDC` : '–'}</dd></div>
            <div><dt>Collateral · debt (USD)</dt><dd>{pos ? `${usd(Number(formatUnits(pos.collateral, 8)))} · ${usd(Number(formatUnits(pos.debt, 8)))}` : '–'}</dd></div>
            <div><dt>Max LTV · liquidation threshold</dt><dd>{pos ? `${Number(pos.ltv) / 100}% · ${Number(pos.liqThreshold) / 100}%` : '–'}</dd></div>
            <div><dt>Health factor (the Pool says)</dt><dd className={hfContract !== null ? hfClass(hfContract) : ''} data-testid="hf">{hfContract === null ? '–' : hfContract === Infinity ? '∞' : fmt(hfContract, 3)}</dd></div>
            <div><dt>Health factor (this UI computes)</dt><dd data-testid="hf-client">{hfClient === null ? '–' : hfClient === Infinity ? '∞' : fmt(hfClient, 3)}{hfContract !== null && hfClient !== null && hfContract !== Infinity && <small className={Math.abs(hfContract - hfClient) < 1e-6 ? 'muted' : 'warn'}> {Math.abs(hfContract - hfClient) < 1e-6 ? '✓ matches' : `✗ off by ${fmt(Math.abs(hfContract - hfClient), 6)}`}</small>}</dd></div>
            <div className="yours"><dt>Your wallet</dt><dd>{pos ? `${fmt(Number(formatUnits(pos.weth, 18)), 4)} WETH · ${fmt(Number(formatUnits(pos.usdc, 6)), 2)} USDC` : 'Connect a wallet'}</dd></div>
          </dl>
        </section>
        <aside className="panel">
          <div className="tabs" role="tablist">{(['supply', 'borrow', 'repay', 'withdraw'] as Tab[]).map((t) => <button key={t} role="tab" className={tab === t ? 'active' : ''} onClick={() => { setTab(t); setAmount(t === 'borrow' || t === 'repay' ? '1000' : '1'); }} data-testid={`tab-${t}`}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
          <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <label className="field"><span>{tab === 'supply' ? 'WETH to supply' : tab === 'borrow' ? 'USDC to borrow' : tab === 'repay' ? 'USDC to repay' : 'WETH to withdraw'}</span>
              <div className="input"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="amount" /><span className="unit">{decimals === 18 ? 'WETH' : 'USDC'}</span></div>
              {pos && <small>{tab === 'borrow' ? `Borrowing power left ${usd(Number(formatUnits(pos.available, 8)))}` : `Available ${fmt(Number(formatUnits(balance, decimals)), 4)} ${decimals === 18 ? 'WETH' : 'USDC'}`}</small>}
            </label>
            <dl className="details">
              <div><dt>Health factor after</dt><dd className={projected !== null ? hfClass(projected) : ''} data-testid="hf-projected">{projected === null ? '–' : projected === Infinity ? '∞' : fmt(projected, 3)}</dd></div>
              <div><dt>Rate</dt><dd>{market ? (tab === 'supply' || tab === 'withdraw' ? `${fmt(market.supplyApr, 2)}% APR earned` : `${fmt(market.borrowApr, 2)}% APR paid`) : '–'}</dd></div>
            </dl>
            <button className="btn primary big" disabled={!w || !amt || amt === 0n || tx.status === 'pending'} data-testid="submit">{!w ? 'Connect a wallet' : needsApproval ? (tab === 'supply' ? 'Approve WETH' : 'Approve USDC') : tab[0].toUpperCase() + tab.slice(1)}</button>
          </form>
          {tx.status !== 'idle' && <div className={`status ${tx.status}`} role="status" data-testid="status" data-state={tx.status}>
            {tx.status === 'pending' && <><span className="spinner" /> {tx.label} — waiting for the block…</>}
            {tx.status === 'confirmed' && <><b>{tx.label}</b> confirmed <small title={tx.hash}>{short(tx.hash)}</small></>}
            {tx.status === 'failed' && <><b>{tx.label}</b> failed: {tx.error}</>}
            {tx.status !== 'pending' && <button className="link" onClick={() => setTx({ status: 'idle' })} aria-label="Dismiss">✕</button>}
          </div>}
        </aside>
      </main>
    </div>
  );
}
