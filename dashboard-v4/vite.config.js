import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* Build sai pra `public/dashboard-v4/` (commitado — zero build no Railway,
   zero risco pro worker shadow, igual ao dashboard atual). Express monta
   `/dashboard-v4` apontando pra esse diretório em src/v3/wire.js.
*/
export default defineConfig({
  base: '/dashboard-v4/',
  plugins: [react()],
  build: {
    outDir: '../public/dashboard-v4',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5174,
    proxy: {
      // dev: proxy /api/* pro Express local (port 3000 default)
      '/api': 'http://localhost:3000',
    },
  },
});
