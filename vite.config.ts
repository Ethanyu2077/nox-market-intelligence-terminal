import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    strictPort: true,
    allowedHosts: ['honest-comics-enter.loca.lt'],
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/ws/live': { target: 'ws://127.0.0.1:8787', ws: true }
    }
  },
  preview: { host: '127.0.0.1', port: 4173 },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        evidence: resolve(__dirname, 'e2e/evidence.html'),
      },
    },
  },
});
