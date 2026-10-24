import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { ShellContext } from '../../components/shellContext'
import { createEventRepository, type EventHome } from './eventRepository'

type Settled = { eventId: string; home: EventHome } | { eventId: string; error: 'not_member' | 'load_failed' }

export type EventHomeState =
  | { status: 'loading' }
  | { status: 'error'; error: 'not_member' | 'load_failed' }
  | { status: 'ready'; home: EventHome }

export function useEventHome(eventId: string): EventHomeState {
  const [settled, setSettled] = useState<Settled | null>(null)
  const setEventName = useOutletContext<ShellContext | undefined>()?.setEventName

  useEffect(() => {
    let cancelled = false
    createEventRepository()
      .getEventHome(eventId)
      .then(
        home => {
          if (cancelled) return
          setSettled({ eventId, home })
          setEventName?.(home.event.name)
        },
        (error: unknown) => {
          if (cancelled) return
          setSettled({ eventId, error: error instanceof Error && error.message === 'not_member' ? 'not_member' : 'load_failed' })
        },
      )
    return () => {
      cancelled = true
    }
  }, [eventId, setEventName])

  if (!settled || settled.eventId !== eventId) return { status: 'loading' }
  return 'home' in settled ? { status: 'ready', home: settled.home } : { status: 'error', error: settled.error }
}
