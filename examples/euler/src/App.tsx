import { useCallback, useEffect, useMemo, useState } from 'react';
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, custom, defineChain, formatUnits, maxUint256, type Address, type EIP1193Provider, type Hex } from 'viem';
import { useWallets, type WalletDetail } from './wallet';
import { WalletButton } from './WalletButton';
import { vaultAbi, evcAbi, erc20Abi, apyPercent } from './protocol';
import { fmt, usd, parseAmount, short } from './format';

export interface Config { evc: Address; collateralVault: Address; borrowVault: Address; weth: Address; usdc: Address; chainId: number }
type Tab = 'deposit' | 'borrow' | 'repay' | 'withdraw';
type TxState = { status: 'idle' } | { status: 'pending'; label: string } | { status: 'confirmed'; label: string; hash: Hex } | { status: 'failed'; label: string; error: string };
interface Market { ltvBorrow: number; ltvLiquidation: number; supplyApy: number; borrowApy: number; usdcCash: bigint; usdcBorrows: bigint }
interface Position { shares: bigint; assets: bigint; maxWithdraw: bigint; debt: bigint; collateralValue: bigint; liabilityValue: bigint; collateralEnabled: boolean; controllerEnabled: boolean; weth: bigint; usdc: bigint; wethAllowance: bigint; usdcAllowance: bigint }

const explain = (e: unknown) => { if (e instanceof BaseError) { const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null; if (r?.reason) return r.reason; if (r?.data) return `${r.data.errorName}(${(r.data.args ?? []).map(String).join(', ')})`; if (/rejected/i.test(e.shortMessage)) return 'You rejected the request in your wallet'; return e.shortMessage; } return String(e); };
const usedClass = (pct: number) => (pct < 60 ? 'ok' : pct < 90 ? 'warn' : 'danger');

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
  const [tab, setTab] = useState<Tab>('deposit');
  const [amount, setAmount] = useState('1');
  const { evc, collateralVault: eWeth, borrowVault: eUsdc, weth, usdc } = config;

  const refresh = useCallback(async () => {
    if (!pub) return;
    const r = <T,>(address: Address, abi: any, functionName: string, args: unknown[] = []) => pub.readContract({ address, abi, functionName, args } as any) as Promise<T>;
    const [ltvB, ltvL, sApy, bApy, cash, borrows, b] = await Promise.all([r<number>(eUsdc, vaultAbi, 'LTVBorrow', [eWeth]), r<number>(eUsdc, vaultAbi, 'LTVLiquidation', [eWeth]), r<bigint>(eWeth, vaultAbi, 'interestRate'), r<bigint>(eUsdc, vaultAbi, 'interestRate'), r<bigint>(eUsdc, vaultAbi, 'cash'), r<bigint>(eUsdc, vaultAbi, 'totalBorrows'), pub.getBlock()]);
    setMarket({ ltvBorrow: ltvB / 100, ltvLiquidation: ltvL / 100, supplyApy: apyPercent(sApy), borrowApy: apyPercent(bApy), usdcCash: cash, usdcBorrows: borrows });
    setBlock({ number: b.number!, timestamp: b.timestamp });
    if (!account) { setPos(null); return; }
    const [shares, maxW, debt, collaterals, controllers, wethBal, usdcBal, wethAllowance, usdcAllowance] = await Promise.all([
      r<bigint>(eWeth, vaultAbi, 'balanceOf', [account]), r<bigint>(eWeth, vaultAbi, 'maxWithdraw', [account]), r<bigint>(eUsdc, vaultAbi, 'debtOf', [account]),
      r<Address[]>(evc, evcAbi, 'getCollaterals', [account]), r<Address[]>(evc, evcAbi, 'getControllers', [account]),
      r<bigint>(weth, erc20Abi, 'balanceOf', [account]), r<bigint>(usdc, erc20Abi, 'balanceOf', [account]), r<bigint>(weth, erc20Abi, 'allowance', [account, eWeth]), r<bigint>(usdc, erc20Abi, 'allowance', [account, eUsdc]),
    ]);
    const assets = await r<bigint>(eWeth, vaultAbi, 'convertToAssets', [shares]);
    const controllerEnabled = controllers.some((c) => c.toLowerCase() === eUsdc.toLowerCase());
    const [collateralValue, liabilityValue] = controllerEnabled ? await r<[bigint, bigint]>(eUsdc, vaultAbi, 'accountLiquidity', [account, false]).catch(() => [0n, 0n] as [bigint, bigint]) : [0n, 0n];
    setPos({ shares, assets, maxWithdraw: maxW, debt, collateralValue, liabilityValue, collateralEnabled: collaterals.some((c) => c.toLowerCase() === eWeth.toLowerCase()), controllerEnabled, weth: wethBal, usdc: usdcBal, wethAllowance, usdcAllowance });
  }, [pub, account, evc, eWeth, eUsdc, weth, usdc]);

  useEffect(() => { if (!pub) return; let last: bigint | null = null, stop = false; refresh().catch(() => {}); const t = setInterval(async () => { const n = await pub.getBlockNumber({ cacheTime: 0 }).catch(() => null); if (n === null || stop) return; if (last === null || n !== last) { last = n; refresh().catch(() => {}); } }, 500); return () => { stop = true; clearInterval(t); }; }, [pub, refresh]);
  useEffect(() => { if (!wallet) return; const on = (a: Address[]) => { setAccounts(a); setAccount(a[0] ?? null); }; wallet.provider.on('accountsChanged', on as any); return () => { wallet.provider.removeListener('accountsChanged', on as any); }; }, [wallet]);
  const connect = async (d: WalletDetail) => { const a = (await d.provider.request({ method: 'eth_requestAccounts' })) as Address[]; setWallet(d); setAccounts(a); setAccount(a[0] ?? null); };
  const run = async (label: string, fn: () => Promise<Hex>) => { if (!pub) return; setTx({ status: 'pending', label }); try { const hash = await fn(); const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error('Transaction reverted on-chain'); setTx({ status: 'confirmed', label, hash }); await refresh(); } catch (e) { setTx({ status: 'failed', label, error: explain(e) }); } };

  const decimals = tab === 'deposit' || tab === 'withdraw' ? 18 : 6;
  const amt = parseAmount(amount, decimals);
  const needsApproval = pos && amt ? (tab === 'deposit' ? pos.wethAllowance < amt : tab === 'repay' ? pos.usdcAllowance < amt : false) : false;
  // Euler's account model: borrowing needs the collateral vault ENABLED for the account and the borrow vault ENABLED as controller
  const needsCollateral = tab === 'borrow' && pos && !pos.collateralEnabled, needsController = tab === 'borrow' && pos && !pos.controllerEnabled;
  const label = !w ? 'Connect a wallet' : needsApproval ? (tab === 'deposit' ? 'Approve WETH' : 'Approve USDC') : needsCollateral ? 'Enable eWETH as collateral' : needsController ? 'Enable eUSDC as controller' : tab[0].toUpperCase() + tab.slice(1);
  const submit = () => {
    if (!w || !account) return;
    if (needsApproval) return run(label, () => w.writeContract({ address: tab === 'deposit' ? weth : usdc, abi: erc20Abi, functionName: 'approve', args: [tab === 'deposit' ? eWeth : eUsdc, maxUint256] }));
    if (needsCollateral) return run(label, () => w.writeContract({ address: evc, abi: evcAbi, functionName: 'enableCollateral', args: [account, eWeth] }));
    if (needsController) return run(label, () => w.writeContract({ address: evc, abi: evcAbi, functionName: 'enableController', args: [account, eUsdc] }));
    if (!amt) return;
    if (tab === 'deposit') return run('Deposit WETH', () => w.writeContract({ address: eWeth, abi: vaultAbi, functionName: 'deposit', args: [amt, account] }));
    if (tab === 'borrow') return run('Borrow USDC', () => w.writeContract({ address: eUsdc, abi: vaultAbi, functionName: 'borrow', args: [amt, account] }));
    if (tab === 'repay') return run('Repay USDC', () => w.writeContract({ address: eUsdc, abi: vaultAbi, functionName: 'repay', args: [amt, account] }));
    return run('Withdraw WETH', () => w.writeContract({ address: eWeth, abi: vaultAbi, functionName: 'withdraw', args: [amt, account, account] }));
  };
  const powerUsed = pos && pos.collateralValue > 0n ? Number((pos.liabilityValue * 10000n) / pos.collateralValue) / 100 : null;
  // the UI's own risk math: liability / (collateral × LTV). collateralValue from the vault is already LTV-adjusted, so
  // the check is: does the vault's ratio match ours within rounding once we account for LTV?
  const balance = pos ? (tab === 'deposit' ? pos.weth : tab === 'repay' ? pos.usdc : tab === 'withdraw' ? pos.maxWithdraw : 0n) : 0n;

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><div><h1>Euler V2</h1><p>eWETH-2 collateral, borrow from eUSDC-2 · mainnet contracts</p></div></div>
        <div className="chainline" data-testid="chain">{block ? <><span className="dot-live" /> chain {config.chainId} · block #{block.number.toString()} · {new Date(Number(block.timestamp) * 1000).toLocaleTimeString()}</> : readProvider ? 'connecting to the chain…' : 'no wallet found'}</div>
        <WalletButton connected={wallet} accounts={accounts} account={account} onConnect={connect} onSelect={setAccount} onDisconnect={() => { setWallet(null); setAccounts([]); setAccount(null); }} />
      </header>
      <main className="grid">
        <section className="pond">
          {market ? (
            <dl className="stats" data-testid="market">
              <div><dt>Borrow LTV · liquidation LTV</dt><dd>{market.ltvBorrow}% · {market.ltvLiquidation}%</dd></div>
              <div><dt>WETH supply APY</dt><dd>{fmt(market.supplyApy, 2)}%</dd></div>
              <div><dt>USDC borrow APY</dt><dd>{fmt(market.borrowApy, 2)}%</dd></div>
              <div><dt>USDC available</dt><dd>{fmt(Number(formatUnits(market.usdcCash, 6)), 0)} USDC</dd></div>
              <div><dt>USDC borrowed (vault)</dt><dd>{fmt(Number(formatUnits(market.usdcBorrows, 6)), 0)} USDC</dd></div>
              <div><dt>Vaults</dt><dd title={`${eWeth} / ${eUsdc}`}>{short(eWeth)} · {short(eUsdc)}</dd></div>
            </dl>
          ) : <div className="stats stats-empty">Reading the vaults…</div>}
          <dl className="stats" data-testid="position">
            <div><dt>Deposited</dt><dd>{pos ? `${fmt(Number(formatUnits(pos.assets, 18)), 4)} WETH` : '–'}</dd></div>
            <div><dt>Borrowed</dt><dd>{pos ? `${fmt(Number(formatUnits(pos.debt, 6)), 2)} USDC` : '–'}</dd></div>
            <div><dt>Collateral enabled · controller enabled</dt><dd>{pos ? `${pos.collateralEnabled ? 'yes' : 'no'} · ${pos.controllerEnabled ? 'yes' : 'no'}` : '–'}</dd></div>
            <div><dt>Risk-adjusted collateral (vault)</dt><dd>{pos && pos.controllerEnabled ? usd(Number(formatUnits(pos.collateralValue, 18))) : '–'}</dd></div>
            <div><dt>Liability (vault)</dt><dd>{pos && pos.controllerEnabled ? usd(Number(formatUnits(pos.liabilityValue, 18))) : '–'}</dd></div>
            <div><dt>Borrowing power used</dt><dd className={powerUsed !== null ? usedClass(powerUsed) : ''} data-testid="power-used">{powerUsed === null ? '–' : `${fmt(powerUsed, 2)}%`}</dd></div>
            <div className="yours"><dt>Your wallet</dt><dd>{pos ? `${fmt(Number(formatUnits(pos.weth, 18)), 4)} WETH · ${fmt(Number(formatUnits(pos.usdc, 6)), 2)} USDC` : 'Connect a wallet'}</dd></div>
          </dl>
        </section>
        <aside className="panel">
          <div className="tabs" role="tablist">{(['deposit', 'borrow', 'repay', 'withdraw'] as Tab[]).map((t) => <button key={t} role="tab" className={tab === t ? 'active' : ''} onClick={() => { setTab(t); setAmount(t === 'borrow' || t === 'repay' ? '1000' : '1'); }} data-testid={`tab-${t}`}>{t[0].toUpperCase() + t.slice(1)}</button>)}</div>
          <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <label className="field"><span>{tab === 'deposit' ? 'WETH to deposit' : tab === 'borrow' ? 'USDC to borrow' : tab === 'repay' ? 'USDC to repay' : 'WETH to withdraw'}</span>
              <div className="input"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="amount" /><span className="unit">{decimals === 18 ? 'WETH' : 'USDC'}</span></div>
              {pos && tab !== 'borrow' && <small>Available {fmt(Number(formatUnits(balance, decimals)), 4)} {decimals === 18 ? 'WETH' : 'USDC'}</small>}
              {pos && tab === 'borrow' && <small>{pos.controllerEnabled ? `Room left ${usd(Number(formatUnits(pos.collateralValue - pos.liabilityValue, 18)))}` : 'Borrowing needs the collateral and the controller enabled — two one-time transactions'}</small>}
            </label>
            <dl className="details">
              <div><dt>Rate</dt><dd>{market ? (decimals === 18 ? `${fmt(market.supplyApy, 2)}% APY earned` : `${fmt(market.borrowApy, 2)}% APY paid`) : '–'}</dd></div>
              <div><dt>Max borrow LTV</dt><dd>{market ? `${market.ltvBorrow}%` : '–'}</dd></div>
            </dl>
            <button className="btn primary big" disabled={!w || tx.status === 'pending' || (!needsCollateral && !needsController && (!amt || amt === 0n))} data-testid="submit">{label}</button>
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
