import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Sitio multipágina estático (Cloudflare Pages: comando `npm run build`, salida `dist`).
export default defineConfig({
  // Rutas relativas: el sitio funciona en la raíz de un dominio o en una subcarpeta.
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        jugar: resolve(import.meta.dirname, 'jugar.html'),
        instructor: resolve(import.meta.dirname, 'instructor.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
      },
    },
  },
});
