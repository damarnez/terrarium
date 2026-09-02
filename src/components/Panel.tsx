import { useEffect, useState } from 'react';
import type { PondStats, TxState } from '../lib/usePond';
import { eth, pepeExact, fmt, parseAmount, short } from '../lib/format';

type Tab = 'swap' | 'add' | 'remove';
type Actions = {
  approve: (amount: bigint) => Promise<void>;
  approveLP: (amount: bigint) => Promise<void>;
  addLiquidity: (eth: bigint, token: bigint, slippageBps: bigint) => Promise<void>;
  removeLiquidity: (shares: bigint, minETH: bigint, minToken: bigint) => Promise<void>;
  swapETH: (eth: bigint, minOut: bigint) => Promise<void>;
  swapPEPE: (token: bigint, minOut: bigint) => Promise<void>;
  quoteToken: (eth: bigint) => Promise<bigint>;
  quoteETH: (token: bigint) => Promise<bigint>;
  getAmountOut: (amountIn: bigint, reserveIn: bigint, reserveOut: bigint) => Promise<bigint>;
  dismiss: () => void;
};

const MAX = 2n ** 256n - 1n;

export function Panel({ stats, tx, actions, connected }: { stats: PondStats | null; tx: TxState; actions: Actions; connected: boolean }) {
  const [tab, setTab] = useState<Tab>('swap');
  const busy = tx.status === 'pending';
  return (
    <aside className="panel" aria-label="Trade and provide liquidity">
      <div className="tabs" role="tablist">
        {(['swap', 'add', 'remove'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)} data-testid={`tab-${t}`}>{t === 'swap' ? 'Swap' : t === 'add' ? 'Add liquidity' : 'Remove'}</button>
        ))}
      </div>
      {tab === 'swap' && <Swap stats={stats} actions={actions} busy={busy} connected={connected} />}
      {tab === 'add' && <Add stats={stats} actions={actions} busy={busy} connected={connected} />}
      {tab === 'remove' && <Remove stats={stats} actions={actions} busy={busy} connected={connected} />}
      <Status tx={tx} onDismiss={actions.dismiss} />
      {stats && connected && (
        <div className="balances" data-testid="balances">
          <span>{eth(stats.ethBalance, 3)} ETH</span><span>{pepeExact(stats.pepeBalance)} PEPE</span><span>{eth(stats.yourShares, 2)} LP</span>
        </div>
      )}
    </aside>
  );
}

function Status({ tx, onDismiss }: { tx: TxState; onDismiss: () => void }) {
  if (tx.status === 'idle') return null;
  return (
    <div className={`status ${tx.status}`} role="status" data-testid="status" data-state={tx.status}>
      {tx.status === 'pending' && <><span className="spinner" /> {tx.label} — waiting for the block…</>}
      {tx.status === 'confirmed' && <><b>{tx.label}</b> confirmed in block #{tx.block.toString()} <small title={tx.hash}>{short(tx.hash)}</small></>}
      {tx.status === 'failed' && <><b>{tx.label}</b> failed: {tx.error}</>}
      {tx.status !== 'pending' && <button className="link" onClick={onDismiss} aria-label="Dismiss">✕</button>}
    </div>
  );
}

function Swap({ stats, actions, busy, connected }: { stats: PondStats | null; actions: Actions; busy: boolean; connected: boolean }) {
  const [dir, setDir] = useState<'eth' | 'pepe'>('eth');
  const [amount, setAmount] = useState('1');
  const [slippage, setSlippage] = useState('0.5');
  const [out, setOut] = useState<bigint | null>(null);
  const amountIn = parseAmount(amount);
  const slipBps = BigInt(Math.round(Math.max(0, Math.min(50, Number(slippage) || 0)) * 100));

  useEffect(() => {
    let live = true;
    if (!stats || !amountIn || amountIn === 0n) { setOut(null); return; }
    const [rin, rout] = dir === 'eth' ? [stats.reserveETH, stats.reserveToken] : [stats.reserveToken, stats.reserveETH];
    actions.getAmountOut(amountIn, rin, rout).then((v) => live && setOut(v)).catch(() => live && setOut(null));
    return () => { live = false; };
  }, [amountIn, dir, stats, actions]);

  const minOut = out ? (out * (10_000n - slipBps)) / 10_000n : 0n;
  let impact = 0;
  if (stats && amountIn && out && out > 0n) {
    const [rin, rout] = dir === 'eth' ? [stats.reserveETH, stats.reserveToken] : [stats.reserveToken, stats.reserveETH];
    const spot = Number(rout) / Number(rin); const exec = Number(out) / Number(amountIn);
    impact = Math.max(0, (1 - exec / spot) * 100);
  }
  const balance = stats ? (dir === 'eth' ? stats.ethBalance : stats.pepeBalance) : 0n;
  const insufficient = !!amountIn && amountIn > balance;
  const needsApproval = dir === 'pepe' && !!stats && !!amountIn && stats.allowance < amountIn;
  const disabled = busy || !connected || !amountIn || amountIn === 0n || !out || insufficient;

  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); if (disabled) return; if (needsApproval) actions.approve(MAX); else if (dir === 'eth') actions.swapETH(amountIn!, minOut); else actions.swapPEPE(amountIn!, minOut); }}>
      <label className="field">
        <span>You pay</span>
        <div className="input">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="swap-amount" aria-label="Amount to swap" />
          <button type="button" className="unit" onClick={() => { setDir(dir === 'eth' ? 'pepe' : 'eth'); setAmount(dir === 'eth' ? '100000' : '1'); }} title="Flip direction" data-testid="swap-flip">{dir === 'eth' ? 'ETH' : 'PEPE'} ⇅</button>
        </div>
        {stats && connected && <small className={insufficient ? 'warn' : ''}>Balance {dir === 'eth' ? `${eth(balance, 4)} ETH` : `${pepeExact(balance)} PEPE`}{insufficient ? ' — not enough' : ''}</small>}
      </label>
      <div className="field readonly">
        <span>You receive</span>
        <div className="input"><output data-testid="swap-out">{out ? (dir === 'eth' ? pepeExact(out) : eth(out, 6)) : '–'}</output><span className="unit">{dir === 'eth' ? 'PEPE' : 'ETH'}</span></div>
      </div>
      <dl className="details">
        <div><dt>Price impact</dt><dd className={impact > 5 ? 'warn' : ''} data-testid="impact">{out ? `${fmt(impact, 2)}%` : '–'}</dd></div>
        <div><dt>Minimum received</dt><dd>{out ? (dir === 'eth' ? `${pepeExact(minOut)} PEPE` : `${eth(minOut, 6)} ETH`) : '–'}</dd></div>
        <div><dt>Slippage tolerance</dt><dd><input className="tiny" inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)} aria-label="Slippage tolerance percent" />%</dd></div>
        <div><dt>Pond fee</dt><dd>0.30% stays with liquidity providers</dd></div>
      </dl>
      <button className="btn primary big" disabled={disabled} data-testid="swap-submit">
        {!connected ? 'Connect a wallet to swap' : needsApproval ? 'Approve PEPE' : dir === 'eth' ? 'Swap ETH for PEPE' : 'Swap PEPE for ETH'}
      </button>
    </form>
  );
}

function Add({ stats, actions, busy, connected }: { stats: PondStats | null; actions: Actions; busy: boolean; connected: boolean }) {
  const [ethIn, setEthIn] = useState('1');
  const [tokenIn, setTokenIn] = useState('');
  const [last, setLast] = useState<'eth' | 'token'>('eth');
  const e = parseAmount(ethIn), t = parseAmount(tokenIn);

  // keep the two legs at the pond's ratio — whichever leg was typed last drives the other
  useEffect(() => {
    let live = true;
    if (!stats || stats.reserveETH === 0n) return;
    if (last === 'eth' && e) actions.quoteToken(e).then((v) => live && setTokenIn(Number(v) / 1e18 > 0 ? String(Math.round(Number(v) / 1e18)) : ''));
    if (last === 'token' && t) actions.quoteETH(t).then((v) => live && setEthIn(String(Number(v) / 1e18)));
    return () => { live = false; };
  }, [ethIn, tokenIn, last, stats?.reserveETH, stats?.reserveToken]); // eslint-disable-line react-hooks/exhaustive-deps

  let shares = 0n, shareAfter = 0;
  if (stats && e && t && stats.totalShares > 0n) {
    const a = (e * stats.totalShares) / stats.reserveETH, b = (t * stats.totalShares) / stats.reserveToken;
    shares = a < b ? a : b;
    shareAfter = (Number(shares) / Number(stats.totalShares + shares)) * 100;
  }
  const needsApproval = !!stats && !!t && stats.allowance < t;
  const insufficient = !!stats && ((!!e && e > stats.ethBalance) || (!!t && t > stats.pepeBalance));
  const disabled = busy || !connected || !e || !t || e === 0n || t === 0n || insufficient;

  return (
    <form className="form" onSubmit={(ev) => { ev.preventDefault(); if (disabled) return; if (needsApproval) actions.approve(MAX); else actions.addLiquidity(e!, t!, 50n); }}>
      <label className="field">
        <span>ETH leg</span>
        <div className="input"><input inputMode="decimal" value={ethIn} onChange={(ev) => { setLast('eth'); setEthIn(ev.target.value); }} data-testid="add-eth" aria-label="ETH to add" /><span className="unit">ETH</span></div>
        {stats && connected && <small>Balance {eth(stats.ethBalance, 4)} ETH</small>}
      </label>
      <label className="field">
        <span>PEPE leg</span>
        <div className="input"><input inputMode="decimal" value={tokenIn} onChange={(ev) => { setLast('token'); setTokenIn(ev.target.value); }} data-testid="add-pepe" aria-label="PEPE to add" /><span className="unit">PEPE</span></div>
        {stats && connected && <small className={insufficient ? 'warn' : ''}>Balance {pepeExact(stats.pepeBalance)} PEPE{insufficient ? ' — not enough for one of the legs' : ''}</small>}
      </label>
      <dl className="details">
        <div><dt>You receive</dt><dd data-testid="add-shares">{shares ? `${eth(shares, 4)} LP tokens` : '–'}</dd></div>
        <div><dt>Share of the pond after</dt><dd>{shares ? `${fmt(shareAfter, 3)}%` : '–'}</dd></div>
        <div><dt>Slippage tolerance</dt><dd>0.5%</dd></div>
      </dl>
      <button className="btn primary big" disabled={disabled} data-testid="add-submit">{!connected ? 'Connect a wallet to add liquidity' : needsApproval ? 'Approve PEPE' : 'Add liquidity'}</button>
    </form>
  );
}

function Remove({ stats, actions, busy, connected }: { stats: PondStats | null; actions: Actions; busy: boolean; connected: boolean }) {
  const [pct, setPct] = useState(50);
  const shares = stats ? (stats.yourShares * BigInt(pct)) / 100n : 0n;
  const outETH = stats && stats.totalShares ? (shares * stats.reserveETH) / stats.totalShares : 0n;
  const outPEPE = stats && stats.totalShares ? (shares * stats.reserveToken) / stats.totalShares : 0n;
  const needsApproval = !!stats && shares > 0n && stats.lpAllowance < shares;   // the router burns LP tokens on your behalf
  const disabled = busy || !connected || shares === 0n;
  return (
    <form className="form" onSubmit={(ev) => { ev.preventDefault(); if (disabled) return; if (needsApproval) actions.approveLP(MAX); else actions.removeLiquidity(shares, (outETH * 995n) / 1000n, (outPEPE * 995n) / 1000n); }}>
      <label className="field">
        <span>Remove {pct}% of your position</span>
        <input type="range" min={1} max={100} value={pct} onChange={(ev) => setPct(Number(ev.target.value))} aria-label="Percent of position to remove" data-testid="remove-pct" />
        <div className="pcts">{[25, 50, 75, 100].map((p) => <button type="button" key={p} className={pct === p ? 'active' : ''} onClick={() => setPct(p)}>{p}%</button>)}</div>
      </label>
      <dl className="details">
        <div><dt>LP tokens to burn</dt><dd>{eth(shares, 4)} LP</dd></div>
        <div><dt>You receive</dt><dd data-testid="remove-out">{eth(outETH, 4)} ETH + {pepeExact(outPEPE)} PEPE</dd></div>
      </dl>
      <button className="btn primary big" disabled={disabled} data-testid="remove-submit">{!connected ? 'Connect a wallet' : shares === 0n ? 'No position to remove' : needsApproval ? 'Approve LP tokens' : 'Remove liquidity'}</button>
    </form>
  );
}
