import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import type { EventMode } from '../../domain/types'

export type CreateEventInput = { name: string; mode: EventMode; currency: 'MYR' }

// `returns table(...)` RPCs come back from supabase-js as an array of rows.
function firstRow<T>(data: T[] | null, fn: string): T {
  const row = data?.[0]
  if (!row) throw new Error(`${fn} returned no rows`)
  return row
}

export function createEventRepository(client: SupabaseClient = supabase) {
  return {
    async createEvent(input: CreateEventInput) {
      const { data, error } = await client.rpc('create_event', input)
      if (error) throw error
      const row = firstRow<{ event_id: string; invite_token: string }>(data, 'create_event')
      return { eventId: row.event_id, inviteToken: row.invite_token }
    },
    async joinEvent(inviteToken: string, displayName: string) {
      const { data, error } = await client.rpc('join_event', { invite_token: inviteToken, display_name: displayName })
      if (error) throw error
      const row = firstRow<{ event_id: string }>(data, 'join_event')
      localStorage.setItem('preferredName', displayName)
      return row.event_id
    },
  }
}
