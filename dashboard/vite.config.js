import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A SPA é servida pelo Express em /dashboard; o build sai pronto em
// public/dashboard/ (commitado — sem build no Railway, zero risco pro
// worker shadow). É um cliente PURO: só fala com /api/v3/data/*.
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  build: {
    outDir: '../public/dashboard',
    emptyOutDir: true,
  },
});
