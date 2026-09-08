# Integrations: Vite, React, Next.js, Storybook, a plain script tag

← [Docs index](README.md) · [Tutorial](tutorial-new-protocol.md) · [Cookbook](cookbook.md) · [API reference](api.md)

**Contents:** [Which path](#-which-path) · [Vite plugin](#-vite-plugin-recommended) · [React component](#%EF%B8%8F-react-component-terrariumreact) ·
[Next.js](#-nextjs) · [Storybook](#-storybook) · [Script tag](#-a-plain-script-tag) · [Checking production](#-checking-the-production-bundle)

There are four ways to get the Terrarium (the chain in a Worker, the EIP-6963 wallet, the dev bar) onto a page. They all
end in the same call, `startTerrarium(worker)` from `@terrariumlabs/core/inject`; they differ in who makes that call and whether
your source has to mention it.

## 🧭 Which path

| you have | use | your source mentions the simulator? |
|---|---|---|
| a Vite app | the [Vite plugin](#-vite-plugin-recommended) | **no**: one `<script>` injected into `index.html` |
| a Vite app that wants a React mount | the [Vite plugin](#-vite-plugin-recommended) with `mount: 'react'` | one import of `virtual:terrarium/react`, null when off |
| Next.js, Remix, CRA, any React app not on Vite | [`@terrariumlabs/react`](#%EF%B8%8F-react-component-terrariumreact) | yes, behind a build-time guard |
| a Storybook | [`@terrariumlabs/react` in a decorator](#-storybook) or the script tag | in the Storybook config, not the app |
| a built site, someone else's dapp, a Playwright test | [a script tag](#-a-plain-script-tag) with `npx terrarium build` | **no** |

```mermaid
flowchart LR
  plugin["🧩 Vite plugin<br/>terrarium/vite"] --> start
  react["⚛️ &lt;Terrarium/&gt;<br/>@terrariumlabs/react"] --> start
  script["📜 &lt;script src=terrarium.js&gt;<br/>npx terrarium build"] --> start
  start["startTerrarium(worker)<br/>terrarium/inject"] --> page["🦊 wallet · 🎛️ dev bar<br/>⚙️ Worker running your scenario"]
  classDef in fill:#fff7d6,stroke:#e8c547,color:#3d3200
  classDef core fill:#e6f2ee,stroke:#1f6f5c,color:#0f3a2e
  class plugin,react,script in
  class start,page core
```

> [!IMPORTANT]
> The project's first rule is that **the dapp never imports the simulator**: what you test is what you ship, byte for
> byte. The Vite plugin and the script tag keep that rule for you. `@terrariumlabs/react` bends it: your source references the
> simulator, and only the guard you write keeps it out of production. Use it when you have to, guard it, and
> [check the bundle](#-checking-the-production-bundle) once.

## 🧩 Vite plugin (recommended)

```sh
npm install -D @terrariumlabs/core
```

```ts
// vite.config.ts
import { terrarium } from '@terrariumlabs/core/vite';
export default defineConfig({
  plugins: [react(), terrarium()],                 // terrarium({ scenario: 'other.scenario.ts', devBar: 'hidden' | false })
  define: { 'process.env.DEBUG': 'undefined', 'process.env.TERRARIUM_DEBUG': 'undefined' },
  build: { target: 'es2022' }, worker: { format: 'es' },
});
```

The plugin writes `.terrarium/{inject,worker}.ts` (gitignore it) and injects one module script into `index.html`.
`VITE_TERRARIUM=off` in `.env` or the environment builds and serves the plain dapp. The [tutorial's step 3](tutorial-new-protocol.md#3-point-your-dapp-at-the-addresses-and-inject-the-terrarium) is the full walkthrough.

A React app on Vite that would rather mount the Terrarium from its tree (a component with context, StrictMode-safe, unmounted
with the tree) than through a script tag does not need the [React component](#%EF%B8%8F-react-component-terrariumreact) path
and its guard: the plugin generates the mount.

```ts
plugins: [react(), terrarium({ mount: 'react' })],        // needs @terrariumlabs/react installed; injects nothing into index.html
```
```tsx
import TerrariumMount from 'virtual:terrarium/react';     // the generated <Terrarium> over the generated Worker
root.render(<>{TerrariumMount && <TerrariumMount />}<App /></>);
```

When the Terrarium is off the module is `export default null`, so the app renders nothing and the bundle carries none of the
simulator: rule 1 holds without a constant of your own (add `/// <reference types="@terrariumlabs/core/vite" />` for the module's types).

## ⚛️ React component (`@terrariumlabs/react`)

```sh
npm install -D @terrariumlabs/react @terrariumlabs/core
```

Two files. The Worker entry, which is what the Vite plugin would have generated:

```ts
// terrarium.worker.ts
import scenario from './terrarium.scenario';
import { runScenario } from '@terrariumlabs/core/worker';
runScenario(scenario);
```

And the component at the root of your tree, behind your bundler's development constant:

```tsx
import { Terrarium } from '@terrariumlabs/react';

export function Root() {
  return (
    <>
      {import.meta.env.DEV && <Terrarium worker={() => new Worker(new URL('./terrarium.worker.ts', import.meta.url), { type: 'module' })} />}
      <App />
    </>
  );
}
```

`new Worker(new URL('./file', import.meta.url), { type: 'module' })` is the form every modern bundler (Vite, webpack 5,
Next.js, Rspack, Parcel) recognises and bundles as a separate Worker chunk. The guard is a constant your bundler replaces
(`import.meta.env.DEV` in Vite, `process.env.NODE_ENV !== 'production'` in webpack and Next.js), so in a production build
the JSX, the Worker and the dynamic scenario import behind it are all dropped.

What the component does: on mount, in a browser, it creates the Worker, announces the wallet and mounts the dev bar; on
unmount it stops everything (`stopTerrarium`), which also makes React StrictMode's double-mount harmless. If a Terrarium is
already on the page (the Vite plugin, an injected script), it reuses it.

> [!TIP]
> wagmi (and libraries like it) reconnect the last wallet synchronously during their first render. A wallet announced from an
> effect a moment later is missed, and every reload comes up disconnected. Render the app as the component's children with
> `defer` (`<Terrarium worker={…} defer><App /></Terrarium>`): they render one tick later, once the wallet is on the page.
> The generated mount of the Vite plugin's `mount: 'react'` does this already.

Its children can call `useTerrarium()` to get the provider for their own dev tools, and `<DevBar provider={…} />` mounts only
the bar over any provider that answers the `terrarium_*` methods. Full surface: [api.md](api.md#terrariumlabsreact).

## ▲ Next.js

Next.js does not compile TypeScript from `node_modules` by default, and the Terrarium packages ship sources. Add them to
`transpilePackages`, and mount the component in a client component:

```js
// next.config.js
module.exports = { transpilePackages: ['@terrariumlabs/core', '@terrariumlabs/react', '@terrariumlabs/evm'] };
```

```tsx
// app/terrarium.tsx
'use client';
import { Terrarium } from '@terrariumlabs/react';
export default function Dev() {
  if (process.env.NODE_ENV === 'production') return null;
  return <Terrarium worker={() => new Worker(new URL('../terrarium.worker.ts', import.meta.url), { type: 'module' })} />;
}
```

and render `<Dev />` once in `app/layout.tsx`. The `process.env.DEBUG` define the Vite config needs is not required:
webpack polyfills `process.env` for the browser. The component is a no-op during server rendering.

## 📚 Storybook

A global decorator mounts the Terrarium once for every story, so components that read the chain through a wallet
provider find "Terrarium Wallet" the way they would in the app:

```tsx
// .storybook/preview.tsx
import { Terrarium } from '@terrariumlabs/react';
export const decorators = [(Story) => <Terrarium worker={() => new Worker(new URL('../terrarium.worker.ts', import.meta.url), { type: 'module' })}><Story /></Terrarium>];
```

Storybook's Vite builder also accepts the Vite plugin directly in `.storybook/main.ts` (`viteFinal`), which keeps the
app's source untouched. With the webpack builder use the decorator above.

## 📜 A plain script tag

```bash
npx terrarium build          # dist-terrarium/terrarium.js: chain, wallet, dev bar and the wasm in one classic script
```

The `terrarium` command is the CLI of `@terrariumlabs/core`, so run it in a project that has the package installed. Without
it, `npx terrarium` would fetch an unrelated package of that name from npm; use `npx -p @terrariumlabs/core terrarium build`
instead.

```html
<script src="/terrarium.js"></script>   <!-- before the dapp's own scripts -->
```

Any page, any framework, no build integration: a deployed preview, a static export, a dapp you do not own. Playwright's
`page.addInitScript({ path: 'dist-terrarium/terrarium.js' })` is the same file injected before the page runs, which is
how the e2e tests work. The scenario's `import.meta.env.VITE_*` values are baked in at build time from the cwd's `.env`.

## ✅ Checking the production bundle

Whichever path you took, look once:

```bash
grep -rl "terrarium" dist/assets | wc -l      # 0 with the Vite plugin or the script tag; 0 with a correct @terrariumlabs/react guard
```

Frogpond's e2e does this on every run (`dappBundleIsPlain`). If the count is not zero with `@terrariumlabs/react`, the guard is
not a constant your bundler replaces: check `import.meta.env.DEV` vs `process.env.NODE_ENV` for your tool.
