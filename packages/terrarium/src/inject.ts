// inject.ts — main-thread side, shared by the dev entry and the standalone bundle: wire the Worker up as an EIP-6963
// wallet (so the dapp's own connect modal lists "Terrarium Wallet") and mount the dev bar. Nothing here is imported by
// the dapp; this is the analogue of a browser extension's injected script.
import { createWorkerProvider } from './bridge.ts';
import { mountDevBar } from './devbar.ts';

const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1F6F5C"/><path d="M9 21c0-4 3-8 7-8s7 4 7 8" fill="none" stroke="#E8C547" stroke-width="2.5" stroke-linecap="round"/><circle cx="16" cy="11" r="2.5" fill="#E8C547"/></svg>');

export function startTerrarium(worker: Worker) {
  const provider = createWorkerProvider(worker);
  const detail = Object.freeze({ info: { uuid: '7e44a1c0-5f0b-4c1e-9b7a-a1b2c3d4e5f6', name: 'Terrarium Wallet', icon: ICON, rdns: 'dev.terrarium' }, provider });
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
  // the wallet's own global (like window.ethereum) — for tests and the console, never for the dapp
  (window as any).terrarium = { provider, request: (method: string, params: unknown[] = []) => provider.request({ method, params }) };
  const mount = () => mountDevBar(provider);
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
  return provider;
}
