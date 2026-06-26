import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The app is what you open in the browser, on :3000. These API paths are proxied to the Fastify
// backend (:3001) so the app and API share an origin in the browser's eyes — the httpOnly session
// cookie is sent on every request and there is no CORS to configure. You never open :3001 directly;
// it's the internal API the proxy forwards to. In production the built assets are served behind the
// same origin as the API, so the proxy is a dev-only concern.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      '/auth': 'http://localhost:3001',
      // ws: true so the editor's WebSocket upgrade (/documents/:id/sync) is proxied too, not just the
      // REST calls under /documents. Same origin in the browser → the session cookie rides the upgrade.
      '/documents': { target: 'http://localhost:3001', ws: true },
      '/health': 'http://localhost:3001',
      '/ready': 'http://localhost:3001',
    },
  },
})
