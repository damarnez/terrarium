// EIP-6963 Multi Injected Provider Discovery — the dapp never imports the Terrarium.
// Whatever announces itself is listed: MetaMask, Rabby, ... or, in dev, the injected "Terrarium Wallet".
import { useEffect, useState } from 'react';
import type { EIP1193Provider } from 'viem';

export interface WalletDetail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}

const found = new Map<string, WalletDetail>();
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', (e: Event) => {
    const d = (e as CustomEvent<WalletDetail>).detail;
    if (!found.has(d.info.uuid)) { found.set(d.info.uuid, d); listeners.forEach((l) => l()); }
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export function useWallets(): WalletDetail[] {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    return () => { listeners.delete(l); };
  }, []);
  return [...found.values()];
}
