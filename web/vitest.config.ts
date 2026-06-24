import { defineConfig } from 'vitest/config'

// Kept separate from vite.config.ts so the dev/build config (which types its plugins against the
// top-level vite) and the test config (which needs vitest's `test` field) don't fight over the two
// vite copies vitest pulls in. Tests don't need the proxy or Tailwind; esbuild transforms the TSX.
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
