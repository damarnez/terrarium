export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export function fmt(n: number, max = 4): string {
  if (!isFinite(n)) return '∞';
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? Math.min(max, 2) : max;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}
export const usd = (n: number) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
export function parseAmount(v: string, decimals: number): bigint | null {
  const t = v.trim().replace(/,/g, '');
  if (!t || !/^\d*\.?\d*$/.test(t) || t === '.') return null;
  const [i = '0', f = ''] = t.split('.');
  return BigInt(i + f.padEnd(decimals, '0').slice(0, decimals));
}
