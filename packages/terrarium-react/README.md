# terrarium-react

Mount the [Terrarium](../terrarium/README.md) from a React tree: the chain in a Worker, the EIP-6963 "Terrarium Wallet"
and the dev bar, for projects that cannot use the Vite plugin (Next.js, Remix, CRA, Storybook).

```tsx
import { Terrarium } from 'terrarium-react';

// terrarium.worker.ts (three lines):  import scenario from './terrarium.scenario'; import { runScenario } from 'terrarium/worker'; runScenario(scenario);
export function Root() {
  return (
    <>
      {process.env.NODE_ENV !== 'production' && <Terrarium worker={() => new Worker(new URL('./terrarium.worker.ts', import.meta.url), { type: 'module' })} />}
      <App />
    </>
  );
}
```

| export | what |
|---|---|
| `<Terrarium worker={() => Worker} devBar?>` | starts the Terrarium on mount (browser only), stops it on unmount; reuses one already on the page; children get `useTerrarium()` |
| `useTerrarium()` | the wallet provider (null until ready), for your own dev tools: `useTerrarium()?.request({ method: 'terrarium_status' })` |
| `<DevBar provider>` | only the dev bar, over any provider that answers the `terrarium_*` methods |

> [!IMPORTANT]
> Prefer the Vite plugin when you can: with it your source never mentions the simulator. With this package it does, and
> only the guard around the component keeps it out of production. Check the production bundle (`grep -rl terrarium dist/`)
> once after setting it up. Guide: [docs/integrations.md](../../docs/integrations.md).
