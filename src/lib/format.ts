import { formatEther, formatUnits } from 'viem';

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** 1,234,567.8 style with a sensible number of decimals for the magnitude */
export function fmt(n: number, max = 4): string {
  if (!isFinite(n)) return '–';
  const abs = Math.abs(n);
  const digits = abs >= 1000 ? 0 : abs >= 1 ? Math.min(max, 2) : max;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

/** compact big token amounts: 8.0M, 420.7B */
export function compact(n: number): string {
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);
}

export const eth = (wei: bigint, max = 4) => fmt(Number(formatEther(wei)), max);
export const pepe = (wei: bigint) => compact(Number(formatUnits(wei, 18)));
export const pepeExact = (wei: bigint) => fmt(Number(formatUnits(wei, 18)), 2);

/** PEPE price expressed in gwei per PEPE (readable magnitude for a meme-coin pair) */
export function gweiPerPepe(reserveETH: bigint, reserveToken: bigint): number {
  if (reserveToken === 0n) return 0;
  return Number((reserveETH * 10n ** 18n) / reserveToken) / 1e9;
}
export const pepePerEth = (reserveETH: bigint, reserveToken: bigint) => (reserveETH === 0n ? 0 : Number(reserveToken) / Number(reserveETH));

export function parseAmount(v: string): bigint | null {
  const t = v.trim().replace(/,/g, '');
  if (!t || !/^\d*\.?\d*$/.test(t) || t === '.') return null;
  const [i = '0', f = ''] = t.split('.');
  return BigInt(i + f.padEnd(18, '0').slice(0, 18));
}
