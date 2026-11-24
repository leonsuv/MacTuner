import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@mactuner/core': new URL('../../packages/core/src/index.ts', import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
