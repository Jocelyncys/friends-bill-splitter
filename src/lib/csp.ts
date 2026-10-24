/**
 * Content-Security-Policy for the production build (injected into index.html by vite.config.ts).
 * Only our own origin plus the configured Supabase project (REST/Storage over http(s), Realtime over ws(s)).
 * No eval or wasm compilation happens on the page: the OCR SDK (opencv Function(), wasm) runs only in its own worker.
 */
export function buildCsp(supabaseUrl?: string): string {
  const supabase = supabaseUrl ? new URL(supabaseUrl).origin : ''
  const realtime = supabase.replace(/^http/, 'ws')
  const directives: [string, ...string[]][] = [
    ['default-src', "'self'"],
    ['script-src', "'self'"],
    ['connect-src', "'self'", supabase, realtime],
    ['img-src', "'self'", 'blob:', 'data:', supabase],
    ['worker-src', "'self'"],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
  ]
  return directives.map(parts => parts.filter(Boolean).join(' ')).join('; ')
}

const CHARSET = '<meta charset="UTF-8" />'

/** Inserts the CSP meta right after <meta charset>; throws so a build can never ship without it. */
export function injectCsp(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
  const result = html.replace(CHARSET, () => `${CHARSET}\n    ${meta}`)
  if (!result.includes(meta)) throw new Error(`Content-Security-Policy meta was not injected: index.html must contain ${CHARSET}`)
  return result
}
