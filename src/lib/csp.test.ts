import { describe, expect, it } from 'vitest'
import { buildCsp } from './csp'

describe('buildCsp', () => {
  it('allows only self plus the Supabase origin and its realtime socket', () => {
    const csp = buildCsp('https://abc.supabase.co/some/path')
    expect(csp).toContain("connect-src 'self' https://abc.supabase.co wss://abc.supabase.co;")
    expect(csp).toContain("img-src 'self' blob: data: https://abc.supabase.co;")
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';")
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
