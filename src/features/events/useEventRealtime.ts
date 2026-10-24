import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'

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
    let wasOffline = false
    const channel = supabase
      .channel(`event:${eventId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `id=eq.${eventId}` }, () => refreshRef.current())
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          setState({ eventId, status: 'live' })
          // Updates may have been missed while disconnected.
          if (wasOffline) refreshRef.current()
          wasOffline = false
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          wasOffline = true
          setState({ eventId, status: 'offline' })
        }
      })
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [eventId])

  return state && state.eventId === eventId ? state.status : 'connecting'
}
