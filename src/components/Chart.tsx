import { useMemo, useState } from 'react';
import type { PricePoint } from '../lib/usePond';
import { fmt } from '../lib/format';

/** Stepped area chart: the price only moves when a swap happens, so it is drawn as steps, not a spline. */
export function Chart({ points }: { points: PricePoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 260, P = { l: 56, r: 16, t: 16, b: 28 };
  const geo = useMemo(() => {
    if (points.length === 0) return null;
    const ys = points.map((p) => p.gwei);
    let min = Math.min(...ys), max = Math.max(...ys);
    if (min === max) { min *= 0.98; max *= 1.02; }
    const pad = (max - min) * 0.12; min -= pad; max += pad;
    const x = (i: number) => P.l + (points.length === 1 ? 0.5 : i / (points.length - 1)) * (W - P.l - P.r);
    const y = (v: number) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
    let d = `M ${x(0)} ${y(points[0].gwei)}`;
    for (let i = 1; i < points.length; i++) d += ` H ${x(i)} V ${y(points[i].gwei)}`;
    if (points.length === 1) d += ` H ${x(0) + 8}`;
    const area = `${d} V ${H - P.b} H ${x(0)} Z`;
    const ticks = [min + pad, (min + max) / 2, max - pad];
    return { x, y, d, area, ticks, min, max };
  }, [points]);

  if (!geo) return <div className="chart chart-empty">Waiting for the first swap…</div>;
  const last = points[points.length - 1];
  const first = points[0];
  const change = first.gwei ? ((last.gwei - first.gwei) / first.gwei) * 100 : 0;
  const h = hover !== null ? points[hover] : null;

  return (
    <div className="chart" data-testid="chart" data-points={points.length}>
      <div className="chart-head">
        <div>
          <div className="chart-price" data-testid="price">{fmt(last.gwei, 2)} <span>gwei per PEPE</span></div>
          <div className={`chart-change ${change >= 0 ? 'up' : 'down'}`}>{change >= 0 ? '▲' : '▼'} {fmt(Math.abs(change), 2)}% since the pond opened · {points.length - 1} price moves</div>
        </div>
        {h && <div className="chart-tip"><b>{fmt(h.gwei, 2)} gwei</b> block #{h.block} · {h.kind === 'open' ? 'pond opened' : h.kind === 'mint' ? 'liquidity added' : h.kind === 'burn' ? 'liquidity removed' : 'swap'}<br /><small>{fmt(Number(h.reserveETH) / 1e18, 3)} ETH · {Intl.NumberFormat('en-US', { notation: 'compact' }).format(Number(h.reserveToken) / 1e18)} PEPE in reserve</small></div>}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="PEPE price over swaps" onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; const i = Math.round(((px - P.l) / (W - P.l - P.r)) * (points.length - 1)); setHover(Math.max(0, Math.min(points.length - 1, i))); }}>
        <defs>
          <linearGradient id="water" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#1F6F5C" stopOpacity="0.35" /><stop offset="100%" stopColor="#9FD3C7" stopOpacity="0.05" /></linearGradient>
        </defs>
        {geo.ticks.map((t, i) => (
          <g key={i}><line x1={P.l} x2={W - P.r} y1={geo.y(t)} y2={geo.y(t)} className="grid" /><text x={P.l - 8} y={geo.y(t) + 4} textAnchor="end" className="axis">{fmt(t, 0)}</text></g>
        ))}
        <path d={geo.area} fill="url(#water)" />
        <path d={geo.d} className="line" />
        {h && <g><line x1={geo.x(h.i)} x2={geo.x(h.i)} y1={P.t} y2={H - P.b} className="cursor" /><circle cx={geo.x(h.i)} cy={geo.y(h.gwei)} r="5" className="dot" /></g>}
        {!h && <circle cx={geo.x(last.i)} cy={geo.y(last.gwei)} r="5" className="dot pulse" />}
        <text x={P.l} y={H - 8} className="axis">block #{first.block}</text>
        <text x={W - P.r} y={H - 8} textAnchor="end" className="axis">block #{last.block}</text>
      </svg>
    </div>
  );
}
