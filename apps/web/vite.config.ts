import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const SERVER = process.env.VITE_SERVER_URL ?? 'http://localhost:9090';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    /**
     * Proxy the API so the browser talks to one origin in dev, exactly as it
     * will in production. Auth is cookie-based, so keeping it same-origin
     * avoids cross-site cookie rules being the difference between dev and prod.
     */
    proxy: {
      '/api': { target: SERVER, changeOrigin: true, ws: true },
      // TeX engine assets, served by the instance (ADR 0020).
      '/tex-assets': { target: SERVER, changeOrigin: true },
      // Theme packs, checked and served by the instance (M44, ADR 0038).
      '/themes': { target: SERVER, changeOrigin: true },
    },
  },
});
