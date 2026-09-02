import type { PondStats } from '../lib/usePond';
import { eth, pepe, fmt, pepePerEth } from '../lib/format';

export function VaultStats({ stats, connected }: { stats: PondStats | null; connected: boolean }) {
  if (!stats) return <div className="stats stats-empty">Reading the pond…</div>;
  const share = stats.totalShares ? (Number(stats.yourShares) / Number(stats.totalShares)) * 100 : 0;
  const yourETH = stats.totalShares ? (stats.reserveETH * stats.yourShares) / stats.totalShares : 0n;
  const yourPEPE = stats.totalShares ? (stats.reserveToken * stats.yourShares) / stats.totalShares : 0n;
  return (
    <dl className="stats" data-testid="stats">
      <div><dt>Reserves</dt><dd data-testid="reserves">{eth(stats.reserveETH, 3)} ETH <em>+</em> {pepe(stats.reserveToken)} PEPE</dd></div>
      <div><dt>Value locked</dt><dd>{eth(stats.reserveETH * 2n, 3)} ETH</dd></div>
      <div><dt>1 ETH buys</dt><dd>{fmt(pepePerEth(stats.reserveETH, stats.reserveToken), 0)} PEPE</dd></div>
      <div><dt>Swaps · fee</dt><dd>{stats.swapCount.toString()} · 0.30%</dd></div>
      <div><dt>Fees earned by LPs (swaps seen)</dt><dd>{eth(stats.feesETH, 4)} ETH <em>+</em> {pepe(stats.feesToken)} PEPE</dd></div>
      <div><dt>LP tokens</dt><dd>{eth(stats.totalShares, 2)} UNI-V2</dd></div>
      <div className="yours"><dt>Your position</dt><dd data-testid="position">{connected ? (stats.yourShares > 0n ? <>{fmt(share, 2)}% <em>=</em> {eth(yourETH, 3)} ETH + {pepe(yourPEPE)} PEPE</> : 'Nothing in the pond yet') : 'Connect a wallet'}</dd></div>
    </dl>
  );
}
