import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { terrarium } from '@terrariumlabs/core/vite';

export default defineConfig({
  // `terrarium()` injects the simulated chain (terrarium.scenario.ts, run in a Worker), its EIP-6963 wallet and the
  // dev bar into index.html. The dapp itself never imports any of it. VITE_TERRARIUM=off => a plain build of a plain dapp.
  plugins: [react(), terrarium({ devBar: 'hidden' })],          // the bar starts collapsed to the leaf at the bottom right; Hide/Show is remembered
  define: { 'process.env.DEBUG': 'undefined', 'process.env.TERRARIUM_DEBUG': 'undefined' },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
  server: { port: 5173 },
  preview: { port: 4173 },
});
