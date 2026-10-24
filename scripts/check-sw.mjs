// Build-output assertion for the generated service worker and page. Run after `npm run build`:
//   node scripts/check-sw.mjs [path/to/sw.js]      (index.html is read from the same folder)
// Fails if the service worker could cache Supabase traffic (payment data), registers any route other than
// the expected ones, precaches the large OCR files, or the page ships without its Content-Security-Policy.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Keep in sync with OCR_ASSETS in vite.config.ts (as Workbox serializes it).
const OCR_ROUTE = String.raw`/\/(ocr-models\/|assets\/(ocr-|worker-entry-|ort-wasm-))/`

const swPath = process.argv[2] ?? 'dist/sw.js'
const raw = readFileSync(swPath, 'utf8')
// Unescape regex slashes so serialized route patterns like \/rest\/v1 are caught too.
const sw = raw.replaceAll('\\/', '/')
const errors = []

const forbidden = ['supabase', '/rest/v1', '/storage/v1', '/auth/v1', '/realtime/v1', ':54321']
if (process.env.VITE_SUPABASE_URL) forbidden.push(new URL(process.env.VITE_SUPABASE_URL).host)
for (const needle of forbidden) {
  if (sw.toLowerCase().includes(needle.toLowerCase())) errors.push(`service worker references "${needle}"`)
}

// Exactly two routes: the app-shell navigation fallback and the same-origin OCR cache. Anything else,
// including catch-alls like /.*/ or a function matcher, could start caching Supabase responses.
const routes = raw.split('registerRoute(').slice(1).map(rest => rest.slice(0, 120))
let navigation = 0
let ocr = 0
for (const route of routes) {
  if (/^new \w+\.NavigationRoute\(/.test(route)) navigation++
  else if (route.startsWith(`${OCR_ROUTE},`)) ocr++
  else errors.push(`unexpected runtime route: ${route.slice(0, 60)}…`)
}
if (navigation !== 1 || ocr !== 1 || routes.length !== 2) {
  errors.push(`expected 1 navigation + 1 OCR route, found ${routes.length} (navigation ${navigation}, OCR ${ocr})`)
}

const precached = [...sw.matchAll(/url:\s*"([^"]+)"/g)].map(match => match[1])
if (!precached.includes('index.html')) errors.push('index.html is not precached')
for (const url of precached) {
  if (/ocr-models\/|assets\/(ocr-|worker-entry-|ort-wasm-)/.test(url)) errors.push(`large OCR file precached: ${url}`)
}

const html = readFileSync(join(dirname(swPath), 'index.html'), 'utf8')
if (!/<meta http-equiv="Content-Security-Policy" content="default-src 'self';/.test(html)) {
  errors.push('index.html has no Content-Security-Policy meta')
}

if (errors.length) {
  console.error(`check-sw: FAILED (${swPath})\n- ${errors.join('\n- ')}`)
  process.exit(1)
}
console.log(`check-sw: OK (${swPath}, ${precached.length} precached entries, ${routes.length} routes, CSP present, no Supabase routes)`)
