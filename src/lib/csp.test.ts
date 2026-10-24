import { describe, expect, it } from 'vitest'
import { buildCsp, injectCsp } from './csp'

describe('buildCsp', () => {
  it('allows only self plus the Supabase origin and its realtime socket', () => {
    const csp = buildCsp('https://abc.supabase.co/some/path')
    expect(csp).toContain("connect-src 'self' https://abc.supabase.co wss://abc.supabase.co;")
    expect(csp).toContain("img-src 'self' blob: data: https://abc.supabase.co;")
    expect(csp).toContain("script-src 'self';")
    expect(csp).toContain("worker-src 'self';")
    expect(csp).not.toContain('wasm-unsafe-eval')
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toMatch(/'unsafe-eval'/)
  })

  it('maps a local http Supabase to ws and keeps the port', () => {
    expect(buildCsp('http://127.0.0.1:54321')).toContain("connect-src 'self' http://127.0.0.1:54321 ws://127.0.0.1:54321;")
  })

  it('falls back to self only when no Supabase URL is configured', () => {
    expect(buildCsp(undefined)).toContain("connect-src 'self';")
    expect(buildCsp('')).toContain("img-src 'self' blob: data:;")
  })
})

describe('injectCsp', () => {
  it('inserts the CSP meta right after <meta charset>', () => {
    const html = '<head>\n    <meta charset="UTF-8" />\n    <title>x</title>'
    expect(injectCsp(html, "default-src 'self'")).toBe(
      `<head>\n    <meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'" />\n    <title>x</title>`,
    )
  })

  it('throws instead of silently shipping a page without a CSP', () => {
    expect(() => injectCsp('<head><meta charset="utf-8"></head>', "default-src 'self'")).toThrow(/Content-Security-Policy/)
  })
})
