import { execSync } from 'node:child_process'
import { defineConfig } from '@playwright/test'

// The e2e suite runs against the local Supabase stack (`npx supabase start`). The app only ever gets the
// public API URL and publishable key; the secret/service_role key is never read here.
function localSupabaseEnv(): { url: string; key: string } {
  if (process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_PUBLISHABLE_KEY) {
    return { url: process.env.VITE_SUPABASE_URL, key: process.env.VITE_SUPABASE_PUBLISHABLE_KEY }
  }
  const out = execSync('npx supabase status -o env', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const read = (name: string) => out.match(new RegExp(`^${name}="([^"]+)"`, 'm'))?.[1]
  const url = read('API_URL')
  const key = read('PUBLISHABLE_KEY')
  if (!url || !key) throw new Error('Local Supabase is not running: start it with `npx supabase start`.')
  // Workers inherit the main process env, so the CLI only runs once per test run.
  process.env.VITE_SUPABASE_URL = url
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = key
  return { url, key }
}

const supabase = localSupabaseEnv()
const PORT = 4173

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 3,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile',
      use: { browserName: 'chromium', viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
    {
      name: 'desktop',
      use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } },
    },
  ],
  // Production build + preview, so the CSP meta tag and the service worker are exercised as deployed.
  // `fetch-ocr-models` is a no-op when the pinned files are already in public/ocr-models/.
  webServer: {
    command: `node scripts/fetch-ocr-models.mjs && npx vite build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { VITE_SUPABASE_URL: supabase.url, VITE_SUPABASE_PUBLISHABLE_KEY: supabase.key },
  },
})
