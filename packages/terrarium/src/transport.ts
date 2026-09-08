// transport.ts — a viem transport over the Terrarium Wallet, for dapps whose reads go through a configured transport
// rather than the connected wallet (wagmi's `createConfig({ transports })`, a `createPublicClient` per chain).
//
// The Terrarium has no RPC server: the wallet provider is the node. A dapp on viem alone can `custom()` the provider it
// discovered through EIP-6963; a wagmi dapp declares one transport per chain up front, before any wallet is known, and
// needs one that finds the provider when the first request comes. That is all this is: `custom()` over the EIP-6963
// announcement with rdns `dev.terrarium`, resolved lazily and once. It imports nothing of the engine, so a dapp that
// uses it ships a few dozen lines, not the simulator; still, keep it behind the same guard as the mount, since a page
// without a Terrarium has nothing to find and reads on that chain fail like reads on an unreachable RPC.
import { custom, type CustomTransport } from 'viem';

export const TERRARIUM_RDNS = 'dev.terrarium';

export interface TerrariumTransportOptions {
  /** how long to wait for the wallet's EIP-6963 announcement before a request fails (default 4000 ms) */
  timeoutMs?: number;
}

let found: Promise<any> | null = null;

/** the Terrarium Wallet's EIP-1193 provider, discovered through EIP-6963 (or `window.terrarium` when already injected) */
export function discoverTerrarium(timeoutMs = 4000): Promise<any> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window: the Terrarium lives in a page'));
  const injected = (window as any).terrarium?.provider;
  if (injected) return Promise.resolve(injected);
  if (found) return found;
  found = new Promise((resolve, reject) => {
    const onAnnounce = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.info?.rdns !== TERRARIUM_RDNS) return;
      done(); resolve(detail.provider);
    };
    const timer = setTimeout(() => { done(); found = null; reject(new Error('Terrarium Wallet not found on this page')); }, timeoutMs);
    const done = () => { clearTimeout(timer); window.removeEventListener('eip6963:announceProvider', onAnnounce); };
    window.addEventListener('eip6963:announceProvider', onAnnounce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  });
  return found;
}

/** a viem transport whose requests go to the Terrarium Wallet: `transports: { [31337]: terrariumTransport() }` in wagmi */
export function terrariumTransport(opts: TerrariumTransportOptions = {}): CustomTransport {
  return custom(
    { request: async (args: { method: string; params?: unknown[] }) => (await discoverTerrarium(opts.timeoutMs)).request(args) },
    { name: 'Terrarium', key: 'terrarium', retryCount: 0 },
  );
}
