// inject.ts — main-thread side, shared by the dev entry and the standalone bundle: wire the Worker up as an EIP-6963
// wallet (so the dapp's own connect modal lists "Terrarium Wallet") and mount the dev bar. Nothing here is imported by
// the dapp; this is the analogue of a browser extension's injected script.
import { createWorkerProvider } from './bridge.ts';
import { mountDevBar } from './devbar.ts';
import { installHttpInterceptor, type WireRoute } from './http.ts';

const ICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1F6F5C"/><path d="M6 25.5c2-6 5.5-8.5 10-8.5s8 2.5 10 8.5" fill="none" stroke="#E8C547" stroke-width="2.5" stroke-linecap="round"/><path d="M16 17.5V9" stroke="#E8C547" stroke-width="2.5" stroke-linecap="round"/><path d="M16 12c0-4.5 3-7 7-7 0 4.5-3 7-7 7Z M16 14.5c0-4.5-3-7-7-7 0 4.5 3 7 7 7Z" fill="#E8C547"/></svg>');

export function startTerrarium(worker: Worker) {
  const provider = createWorkerProvider(worker);
  // the scenario's HTTP routes (subgraphs, APIs answered from the chain): the Worker announces them before it boots;
  // the RPC is the fallback. Until either arrives, the dapp's fetches wait; nothing else about them changes.
  const routes = new Promise<WireRoute[]>((res) => { provider.on('httpRoutes', (r) => res(r as WireRoute[])); provider.request({ method: 'terrarium_httpRoutes' }).then((r) => res(r as WireRoute[]), () => res([])); });
  installHttpInterceptor(provider, routes);
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
