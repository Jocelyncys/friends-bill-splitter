import { supabase } from '../../lib/supabase'

/**
 * Reuses the stored session or signs in anonymously.
 * `captchaToken` is required once CAPTCHA is enabled for the hosted project; no provider widget is
 * wired yet (see README "Release checklist"), so callers currently pass nothing.
 */
export async function ensureAnonymousSession({ captchaToken }: { captchaToken?: string } = {}): Promise<string> {
  const { data: existing } = await supabase.auth.getSession()
  if (existing.session) return existing.session.user.id
  const { data, error } = await supabase.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined)
  if (error || !data.user) throw error ?? new Error('Anonymous sign-in failed')
  return data.user.id
}
