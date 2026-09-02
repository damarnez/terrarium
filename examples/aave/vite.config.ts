import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { terrarium } from 'terrarium/vite';

export default defineConfig({
  plugins: [react(), terrarium()],
  define: { 'process.env.DEBUG': 'undefined', 'process.env.TERRARIUM_DEBUG': 'undefined' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  worker: { format: 'es' },
  server: { port: 5174 },
});
