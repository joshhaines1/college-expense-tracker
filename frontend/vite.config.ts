import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development Vite proxies /api to the local backend, so the app is same-origin there too (no CORS).
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': 'http://127.0.0.1:3001' } },
  build: { sourcemap: false },
});
