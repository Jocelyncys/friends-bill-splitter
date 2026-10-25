import { beforeEach, describe, expect, it, vi } from 'vitest'

const auth = vi.hoisted(() => ({ getSession: vi.fn(), signInAnonymously: vi.fn() }))
vi.mock('../../lib/supabase', () => ({ supabase: { auth } }))

import { ensureAnonymousSession } from './anonymousSession'

describe('ensureAnonymousSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    auth.getSession.mockResolvedValue({ data: { session: null } })
    auth.signInAnonymously.mockResolvedValue({ data: { user: { id: 'u-1' } }, error: null })
  })

  it('reuses an existing session without signing in again', async () => {
    auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'u-0' } } } })
    await expect(ensureAnonymousSession()).resolves.toBe('u-0')
    expect(auth.signInAnonymously).not.toHaveBeenCalled()
  })

  it('signs in anonymously without options when there is no CAPTCHA token', async () => {
    await expect(ensureAnonymousSession()).resolves.toBe('u-1')
    expect(auth.signInAnonymously).toHaveBeenCalledWith(undefined)
  })

  it('passes a CAPTCHA token through to Supabase Auth', async () => {
    await ensureAnonymousSession({ captchaToken: 'cap-123' })
    expect(auth.signInAnonymously).toHaveBeenCalledWith({ options: { captchaToken: 'cap-123' } })
  })

  it('throws when sign-in fails', async () => {
    const error = new Error('captcha verification process failed')
    auth.signInAnonymously.mockResolvedValue({ data: { user: null }, error })
    await expect(ensureAnonymousSession()).rejects.toBe(error)
  })
})
