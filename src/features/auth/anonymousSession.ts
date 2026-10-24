import { supabase } from '../../lib/supabase'

export async function ensureAnonymousSession(): Promise<string> {
  const { data: existing } = await supabase.auth.getSession()
  if (existing.session) return existing.session.user.id
  const { data, error } = await supabase.auth.signInAnonymously()
  if (error || !data.user) throw error ?? new Error('Anonymous sign-in failed')
  return data.user.id
}
