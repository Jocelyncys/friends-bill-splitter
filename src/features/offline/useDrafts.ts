import { useEffect, useState } from 'react'
import { listDrafts, subscribeDrafts, type ExpenseDraft } from './draftDb'

/** Expenses saved on this device and not yet on the server (all events, or one). */
export function useDrafts(eventId?: string): ExpenseDraft[] {
  const [drafts, setDrafts] = useState<ExpenseDraft[]>([])
  useEffect(() => {
    let cancelled = false
    const load = () =>
      listDrafts(eventId).then(
        found => !cancelled && setDrafts(found),
        () => undefined, // IndexedDB unavailable: behave as if there are none
      )
    void load()
    const unsubscribe = subscribeDrafts(() => void load())
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [eventId])
  return drafts
}

/** Browser "leave site?" prompt, registered only while unsynced drafts exist. */
export function useUnsyncedWarning() {
  const hasDrafts = useDrafts().length > 0
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
