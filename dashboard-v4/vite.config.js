import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* E0: build local mock-only. `base: './'` deixa os caminhos relativos,
   então o bundle funciona em qualquer mount (raiz, /dashboard-v4, file://).
   No E8, quando o Express servir `build/` em /dashboard, mudamos pra
   `/dashboard/` se preciso.
*/
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'build',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5174, // não colide com o dashboard atual (5173)
    strictPort: false,
  },
});
