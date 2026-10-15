/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// El panel se sirve bajo /admin/. En desarrollo, /v1 se reenvía a la API (mismo origen: la cookie del refresh token y la
// protección CSRF funcionan igual que en producción, donde Nginx reenvía /v1 a la API).
export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/v1': { target: process.env['API_URL'] ?? 'http://127.0.0.1:3000', changeOrigin: false } },
  },
  build: { sourcemap: false, target: 'es2022' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    css: false,
  },
});
