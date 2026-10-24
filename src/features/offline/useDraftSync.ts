import { useCallback, useEffect } from 'react'
import { createExpenseRepository } from '../expenses/expenseRepository'
import { resetSyncingDrafts } from './draftDb'
import { syncStoredDrafts } from './syncDrafts'

let startupDone = false

/** Syncs saved drafts on start and whenever the browser comes back online. Returns a manual trigger. */
export function useDraftSync(onSynced: () => void) {
  const syncNow = useCallback(async () => {
    try {
      const synced = await syncStoredDrafts(payload => createExpenseRepository().saveExpense(payload))
      if (synced > 0) onSynced()
    } catch {
      // IndexedDB unavailable or storage error: nothing to sync
    }
  }, [onSynced])

  useEffect(() => {
    // Once per page load: drafts left 'syncing' by a closed page are not in flight any more.
    const start = startupDone ? Promise.resolve() : resetSyncingDrafts().catch(() => undefined)
    startupDone = true
    void start.then(syncNow)
    const onOnline = () => void syncNow()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [syncNow])

  return syncNow
}
