import react from '@vitejs/plugin-react'
import { loadEnv, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { configDefaults, defineConfig } from 'vitest/config'
import { buildCsp, injectCsp } from './src/lib/csp.ts'

// OCR files are large and only needed when someone scans a receipt: keep them out of the precache
// and cache them on first use instead. Bump the cache name when the pinned model/runtime files change.
const OCR_ASSETS = /\/(ocr-models\/|assets\/(ocr-|worker-entry-|ort-wasm-))/

// Production-only CSP meta tag (Vite's dev server needs inline scripts and its own websocket).
// Inserted right after <meta charset> so it precedes every script and stylesheet.
function cspPlugin(supabaseUrl: string | undefined): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: html => injectCsp(html, buildCsp(supabaseUrl)),
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    react(),
    cspPlugin(loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false, // registered from main.tsx via virtual:pwa-register
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'], // manifest icons are added automatically
      manifest: {
        name: 'Friends Bill Splitter',
        short_name: 'Bill Splitter',
        start_url: './',
        display: 'standalone',
        background_color: '#fff8fc',
        theme_color: '#763e61',
        icons: [
          { src: './icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: './icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: './icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/\/ocr-models\//],
        // App shell only. Supabase is cross-origin and matched by no route, so API responses are never cached.
        globPatterns: ['**/*.{js,css,html}'],
        globIgnores: ['**/ocr-models/**', '**/assets/ocr-*', '**/assets/worker-entry-*', '**/assets/ort-wasm-*'],
        runtimeCaching: [
          {
            urlPattern: OCR_ASSETS,
            handler: 'CacheFirst',
            // 6 OCR files today (worker, SDK chunk, SDK worker, 2 models, wasm); the cap evicts stale hashed copies.
            options: { cacheName: 'ocr-assets-v1', cacheableResponse: { statuses: [200] }, expiration: { maxEntries: 8 } },
          },
        ],
      },
    }),
  ],
  build: {
    rolldownOptions: {
      // The OCR SDK's opencv-js has Node-only imports it never reaches in the browser; hide only those warnings.
      onLog(level, log, handler) {
        if (log.message.includes('opencv-js') && /Module "(fs|path|crypto)" has been externalized/.test(log.message)) return
        handler(level, log)
      },
    },
  },
  worker: {
    format: 'es',
    // The only app worker is the OCR host (src/features/ocr/ocr.worker.ts): prefix its files so the
    // service worker excludes them from precache and caches them on first use.
    rolldownOptions: {
      onLog(level, log, handler) {
        if (log.message.includes('opencv-js') && /Module "(fs|path|crypto)" has been externalized/.test(log.message)) return
        handler(level, log)
      },
      output: { entryFileNames: 'assets/ocr-[name]-[hash].js', chunkFileNames: 'assets/ocr-[name]-[hash].js' },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    exclude: [...configDefaults.exclude, 'e2e/**'], // Playwright specs, run by `npm run e2e`
    // Dummy values so createClient() does not throw at import time in tests.
    env: { VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: 'test-publishable-key' },
  },
}))
