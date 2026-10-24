import { useEffect, useState } from 'react'
import { watchDrafts, type ExpenseDraft } from './draftDb'

/**
 * Expenses saved on this device and not yet on the server (all events, or one). Backed by watchDrafts (Dexie liveQuery),
 * so changes made in other tabs show up too. `loaded` stays false until the first read has finished, so callers
 * can avoid acting on an empty list that only means "not read yet".
 */
export function useDrafts(eventId?: string): { drafts: ExpenseDraft[]; loaded: boolean } {
  const [state, setState] = useState<{ drafts: ExpenseDraft[]; loaded: boolean }>({ drafts: [], loaded: false })
  useEffect(() => {
    return watchDrafts(
      eventId,
      drafts => setState({ drafts, loaded: true }),
      () => setState({ drafts: [], loaded: true }), // IndexedDB unavailable: behave as if there are none
    )
  }, [eventId])
  return state
}

/** Browser "leave site?" prompt, registered only while unsynced drafts exist. */
export function useUnsyncedWarning() {
  const hasDrafts = useDrafts().drafts.length > 0
  useEffect(() => {
    if (!hasDrafts) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasDrafts])
}
