import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const target = process.env.FLOWNODE_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/ws': { target: target.replace('http', 'ws'), ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 900 },
});
