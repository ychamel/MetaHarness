import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run ui:dev` serves the app with hot reload and passes API calls to a running daemon;
// `npm run ui:build` writes ui/dist, which the daemon serves at /.
const daemon = `http://127.0.0.1:${process.env.MH_PORT ?? 7777}`;

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: Object.fromEntries(['/state', '/events', '/goals', '/agent', '/commands'].map(p => [p, daemon])),
  },
});
