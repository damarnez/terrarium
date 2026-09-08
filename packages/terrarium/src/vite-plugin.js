// The Vite plugin. Plain JavaScript on purpose: Vite loads it in Node straight from the consumer's node_modules, where
// Node refuses to strip types from .ts files (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Types live in vite-plugin.d.ts.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { loadEnv } from 'vite';

/** the virtual module a React app imports its mount from when `mount: 'react'` */
export const REACT_MOUNT_ID = 'virtual:terrarium/react';
const REACT_MOUNT_OFF = '\0terrarium/react-off';

/** Injects the Terrarium (chain in a Worker + EIP-6963 wallet + dev bar) into the page.
 *  Default: one module script added to index.html; the dapp's source is untouched. `mount: 'react'`: nothing is injected
 *  and the app imports `TerrariumMount` from 'virtual:terrarium/react' and renders it at its root (a `@terrariumlabs/react`
 *  <Terrarium> over the generated Worker); when the Terrarium is off that module exports null, so the app renders
 *  nothing and bundles none of it. Remove the plugin, or set VITE_TERRARIUM=off, and nothing of it is built either way.
 *  @param {import('./vite-plugin.d.ts').TerrariumPluginOptions} [opts]
 *  @returns {import('vite').Plugin} */
export function terrarium(opts = {}) {
  let enabled = true, reactMount = null;
  const react = opts.mount === 'react';
  return {
    name: 'terrarium',
    configResolved(config) {
      enabled = loadEnv(config.mode, config.envDir ?? config.root, 'VITE_').VITE_TERRARIUM !== 'off';   // loadEnv merges .env files and the process environment
      if (!enabled) { config.logger.info('[terrarium] off — plain dapp build'); return; }
      const scenario = '/' + relative(config.root, resolve(config.root, opts.scenario ?? 'terrarium.scenario.ts')).split(sep).join('/');
      const dir = resolve(config.root, '.terrarium'); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'worker.ts'), workerEntry(scenario));
      if (react) {
        reactMount = join(dir, 'react.tsx');
        writeFileSync(reactMount, reactMountEntry(opts.devBar));
        config.logger.info(`[terrarium] React mount at ${REACT_MOUNT_ID} (scenario ${scenario})`);
        return;
      }
      const start = opts.devBar === undefined ? '' : `, { devBar: ${JSON.stringify(opts.devBar)} }`;
      writeFileSync(join(dir, 'inject.ts'), `import { startTerrarium } from '@terrariumlabs/core/inject';\nstartTerrarium(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })${start});\n`);
      config.logger.info(`[terrarium] injecting the simulated chain (scenario ${scenario})`);
    },
    resolveId(source) {
      if (source !== REACT_MOUNT_ID) return null;
      return enabled && react ? reactMount : REACT_MOUNT_OFF;
    },
    load(id) {
      if (id !== REACT_MOUNT_OFF) return null;
      return 'export const enabled = false;\nexport default null;\n';
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html) { return enabled && !react ? { html, tags: [{ tag: 'script', attrs: { type: 'module', src: '/.terrarium/inject.ts' }, injectTo: 'body' }] } : html; },
    },
  };
}

/** the Worker entry: the user's scenario + the runtime (also used by the CLI's standalone build)
 *  @param {string} scenarioImport */
export const workerEntry = (scenarioImport) => `import scenario from '${scenarioImport}';\nimport { runScenario } from '@terrariumlabs/core/worker';\nrunScenario(scenario);\n`;

/** the generated React mount: a <Terrarium> over the generated Worker, with the plugin's devBar option baked in
 *  @param {boolean | 'hidden' | undefined} devBar */
export const reactMountEntry = (devBar) => `import { createElement, type ReactNode } from 'react';
import { Terrarium } from '@terrariumlabs/react';
export const enabled = true;
/** the Terrarium mounted from the React tree: render once at the root, with the app as its children (they render once
 *  the wallet is announced, so a wallet library that reconnects during its first render finds it) */
export default function TerrariumMount({ children }: { children?: ReactNode } = {}) {
  return createElement(Terrarium, { worker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }), defer: true${devBar === undefined ? '' : `, devBar: ${JSON.stringify(devBar)}`} }, children);
}
`;
