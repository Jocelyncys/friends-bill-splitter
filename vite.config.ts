import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    rolldownOptions: {
      // The OCR SDK's opencv-js has Node-only imports it never reaches in the browser; hide only those warnings.
      onLog(level, log, handler) {
        if (log.message.includes('opencv-js') && /Module "(fs|path|crypto)" has been externalized/.test(log.message)) return
        handler(level, log)
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    // Dummy values so createClient() does not throw at import time in tests.
    env: { VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key' },
  },
})
