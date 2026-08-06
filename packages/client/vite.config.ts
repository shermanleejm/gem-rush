import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // The host serves this directory directly.
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    // §5 budgets a <2MB gzipped bundle; warn well before we get there.
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    // In dev the Vite server proxies the socket to the host process, so the
    // client code never needs to know which of the two it is talking to.
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
