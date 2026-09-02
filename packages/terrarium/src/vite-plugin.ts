import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { loadEnv, type Plugin } from 'vite';

export interface TerrariumPluginOptions {
  /** the scenario module (default export of defineScenario), relative to the Vite root. Default: terrarium.scenario.ts */
  scenario?: string;
}

/** Injects the Terrarium (chain in a Worker + EIP-6963 wallet + dev bar) into index.html as a separate module script.
 *  The dapp's source is untouched: remove the plugin, or set VITE_TERRARIUM=off, and nothing of it is built. */
export function terrarium(opts: TerrariumPluginOptions = {}): Plugin {
  let enabled = true;
  return {
    name: 'terrarium',
    configResolved(config) {
      enabled = loadEnv(config.mode, config.envDir ?? config.root, 'VITE_').VITE_TERRARIUM !== 'off';   // loadEnv merges .env files and the process environment
      if (!enabled) { config.logger.info('[terrarium] off — plain dapp build'); return; }
      const scenario = '/' + relative(config.root, resolve(config.root, opts.scenario ?? 'terrarium.scenario.ts')).split(sep).join('/');
      const dir = resolve(config.root, '.terrarium'); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'worker.ts'), workerEntry(scenario));
      writeFileSync(join(dir, 'inject.ts'), `import { startTerrarium } from 'terrarium/inject';\nstartTerrarium(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }));\n`);
      config.logger.info(`[terrarium] injecting the simulated chain (scenario ${scenario})`);
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) { return enabled ? { html, tags: [{ tag: 'script', attrs: { type: 'module', src: '/.terrarium/inject.ts' }, injectTo: 'body' }] } : html; },
    },
  };
}

/** the Worker entry: the user's scenario + the runtime (also used by the CLI's standalone build) */
export const workerEntry = (scenarioImport: string) => `import scenario from '${scenarioImport}';\nimport { runScenario } from 'terrarium/worker';\nrunScenario(scenario);\n`;
