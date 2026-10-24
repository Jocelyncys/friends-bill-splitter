// Build-output assertion for the generated service worker. Run after `npm run build`:
//   node scripts/check-sw.mjs [path/to/sw.js]
// Fails if the service worker could cache Supabase traffic (payment data) or precaches the large OCR files.
import { readFileSync } from 'node:fs'

const swPath = process.argv[2] ?? 'dist/sw.js'
// Unescape regex slashes so serialized route patterns like \/rest\/v1 are caught too.
const sw = readFileSync(swPath, 'utf8').replaceAll('\\/', '/')
const errors = []

const forbidden = ['supabase', '/rest/v1', '/storage/v1', '/auth/v1', '/realtime/v1', ':54321']
if (process.env.VITE_SUPABASE_URL) forbidden.push(new URL(process.env.VITE_SUPABASE_URL).host)
for (const needle of forbidden) {
  if (sw.toLowerCase().includes(needle.toLowerCase())) errors.push(`service worker references "${needle}"`)
}

const precached = [...sw.matchAll(/url:\s*"([^"]+)"/g)].map(match => match[1])
if (!precached.includes('index.html')) errors.push('index.html is not precached')
for (const url of precached) {
  if (/ocr-models\/|assets\/(ocr-|worker-entry-|ort-wasm-)/.test(url)) errors.push(`large OCR file precached: ${url}`)
}

if (errors.length) {
  console.error(`check-sw: FAILED (${swPath})\n- ${errors.join('\n- ')}`)
  process.exit(1)
}
console.log(`check-sw: OK (${swPath}, ${precached.length} precached entries, no Supabase routes)`)
