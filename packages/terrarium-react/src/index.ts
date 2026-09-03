// terrarium-react — mount the Terrarium from a React tree.
//
// The Vite plugin (`terrarium/vite`) is the recommended way in: it injects the chain, wallet and dev bar into index.html
// and your source never mentions the simulator. This package is for projects that cannot use it (Next.js, Remix, CRA, a
// Storybook, a design system playground): one component starts the Worker, announces the EIP-6963 wallet and mounts the
// dev bar; a hook hands the provider to your own dev tools. Guard it with your bundler's constant so it compiles to nothing
// in production:
//
//   {import.meta.env.DEV && <Terrarium worker={() => new Worker(new URL('./terrarium.worker.ts', import.meta.url), { type: 'module' })} />}
//
// where terrarium.worker.ts is three lines: import scenario from './terrarium.scenario'; import { runScenario } from 'terrarium/worker'; runScenario(scenario);
import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react';
import { startTerrarium, stopTerrarium, type StartOptions } from 'terrarium/inject';
import { mountDevBar } from 'terrarium/devbar';
import type { WorkerProvider } from 'terrarium/bridge';

const Ctx = createContext<WorkerProvider | null>(null);

export interface TerrariumProps extends StartOptions {
  /** creates the Worker that runs your scenario: () => new Worker(new URL('./terrarium.worker.ts', import.meta.url), { type: 'module' }) */
  worker: () => Worker;
  children?: ReactNode;
}

/** Starts the Terrarium when mounted (browser only; a no-op during SSR), stops it when unmounted. Renders its children,
 *  giving them `useTerrarium()`. If a Terrarium is already on the page (the Vite plugin or an injected script), it reuses
 *  that one instead of starting a second chain. */
export function Terrarium({ worker, devBar = true, children }: TerrariumProps) {
  const [provider, setProvider] = useState<WorkerProvider | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const existing = (window as any).terrarium?.provider as WorkerProvider | undefined;
    if (existing) { setProvider(existing); return; }
    setProvider(startTerrarium(worker(), { devBar }));
    return () => { stopTerrarium(); setProvider(null); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps -- one chain per mount, by design
  return createElement(Ctx.Provider, { value: provider }, children ?? null);
}

/** The wallet provider of the mounted Terrarium (null until the Worker is ready), for your own dev tools:
 *  `useTerrarium()?.request({ method: 'terrarium_status' })`. Never for the dapp itself. */
export function useTerrarium(): WorkerProvider | null { return useContext(Ctx); }

/** Only the dev bar, over any EIP-1193 provider that answers the terrarium_* methods (one you started yourself, or a
 *  `terrarium serve` endpoint some day). Mounts on the body as a fixed footer, removes itself on unmount. */
export function DevBar({ provider }: { provider: { request(a: { method: string; params?: unknown[] }): Promise<any> } | null }) {
  useEffect(() => {
    if (typeof document === 'undefined' || !provider) return;
    mountDevBar(provider);
    return () => { document.getElementById('terrarium-devbar')?.remove(); document.body.style.removeProperty('padding-bottom'); };
  }, [provider]);
  return null;
}
