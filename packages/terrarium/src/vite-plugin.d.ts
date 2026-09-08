import type { Plugin } from 'vite';

export interface TerrariumPluginOptions {
  /** the scenario module (default export of defineScenario), relative to the Vite root. Default: terrarium.scenario.ts */
  scenario?: string;
}

/** Injects the Terrarium (chain in a Worker + EIP-6963 wallet + dev bar) into index.html as a separate module script.
 *  The dapp's source is untouched: remove the plugin, or set VITE_TERRARIUM=off, and nothing of it is built. */
export function terrarium(opts?: TerrariumPluginOptions): Plugin;

/** the Worker entry: the user's scenario + the runtime (also used by the CLI's standalone build) */
export function workerEntry(scenarioImport: string): string;
