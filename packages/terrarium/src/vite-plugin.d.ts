import type { Plugin } from 'vite';

export interface TerrariumPluginOptions {
  /** the scenario module (default export of defineScenario), relative to the Vite root. Default: terrarium.scenario.ts */
  scenario?: string;
  /** the dev bar: true (default), 'hidden' (starts collapsed to the leaf; a Hide/Show click is remembered and wins), false (none) */
  devBar?: boolean | 'hidden';
  /** how the Terrarium reaches the page. 'script' (default): one module script injected into index.html, the app's
   *  source untouched. 'react': nothing injected; the app renders `TerrariumMount` from 'virtual:terrarium/react' at its
   *  root (a `@terrariumlabs/react` <Terrarium> over the generated Worker, so StrictMode, context and unmount are handled),
   *  and that module exports null when the Terrarium is off. Needs `@terrariumlabs/react` installed */
  mount?: 'script' | 'react';
}

/** Injects the Terrarium (chain in a Worker + EIP-6963 wallet + dev bar) into the page: a script tag by default, or a
 *  React mount the app imports from 'virtual:terrarium/react'. Remove the plugin, or set VITE_TERRARIUM=off, and nothing
 *  of it is built. */
export function terrarium(opts?: TerrariumPluginOptions): Plugin;

/** the Worker entry: the user's scenario + the runtime (also used by the CLI's standalone build) */
export function workerEntry(scenarioImport: string): string;

/** the generated React mount module (what 'virtual:terrarium/react' resolves to when the Terrarium is on) */
export function reactMountEntry(devBar?: boolean | 'hidden'): string;

/** the virtual module id of the React mount */
export const REACT_MOUNT_ID: 'virtual:terrarium/react';

declare module 'virtual:terrarium/react' {
  import type { ComponentType, ReactNode } from 'react';
  /** true when the Terrarium is on in this build */
  export const enabled: boolean;
  /** the mount, or null when the Terrarium is off: `{TerrariumMount && <TerrariumMount />}` */
  const TerrariumMount: ComponentType<{ children?: ReactNode }> | null;
  export default TerrariumMount;
}
