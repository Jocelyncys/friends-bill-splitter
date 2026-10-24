import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'

const REFRESH_DEBOUNCE_MS = 200

export type RealtimeStatus = 'connecting' | 'live' | 'offline'

// Scope: ONLY the open event's row in public.events. Every mutation bumps
// events.revision (migration 0007), so one payload means "refetch". Row-level tables
// are deliberately not published: Realtime does not apply RLS to DELETE payloads.
export function useEventRealtime(eventId: string | undefined, refresh: () => void): RealtimeStatus {
  const [state, setState] = useState<{ eventId: string; status: RealtimeStatus } | null>(null)
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  })

  useEffect(() => {
    if (!eventId) return
    // Late callbacks from a removed channel (removeChannel emits CLOSED asynchronously)
    // must not touch the state of its replacement.
    let active = true
    let timer: ReturnType<typeof setTimeout> | null = null
    // Coalesce bursts (our own action's revision bump plus its local refresh, reconnects).
    const scheduleRefresh = () => {
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        if (active) refreshRef.current()
      }, REFRESH_DEBOUNCE_MS)
    }
    const channel = supabase
      .channel(`event:${eventId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `id=eq.${eventId}` }, () => {
        if (active) scheduleRefresh()
      })
      .subscribe(status => {
        if (!active) return
        if (status === 'SUBSCRIBED') {
          setState({ eventId, status: 'live' })
          // Catch up on changes made before the subscription or while disconnected.
          scheduleRefresh()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setState({ eventId, status: 'offline' })
        }
      })
    return () => {
      active = false
      if (timer !== null) clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [eventId])

  return state && state.eventId === eventId ? state.status : 'connecting'
}
