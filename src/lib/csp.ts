/**
 * Content-Security-Policy for the production build (injected into index.html by vite.config.ts).
 * Only our own origin plus the configured Supabase project (REST/Storage over http(s), Realtime over ws(s)).
 * 'wasm-unsafe-eval' lets the OCR engine compile its WebAssembly; nothing else needs eval.
 */
export function buildCsp(supabaseUrl?: string): string {
  const supabase = supabaseUrl ? new URL(supabaseUrl).origin : ''
  const realtime = supabase.replace(/^http/, 'ws')
  const directives: [string, ...string[]][] = [
    ['default-src', "'self'"],
    ['script-src', "'self'", "'wasm-unsafe-eval'"],
    ['connect-src', "'self'", supabase, realtime],
    ['img-src', "'self'", 'blob:', 'data:', supabase],
    ['worker-src', "'self'", 'blob:'],
    ['object-src', "'none'"],
    ['base-uri', "'self'"],
  ]
  return directives.map(parts => parts.filter(Boolean).join(' ')).join('; ')
}
