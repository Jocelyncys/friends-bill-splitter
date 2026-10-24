import { useCallback, useEffect } from 'react'
import { createExpenseRepository } from '../expenses/expenseRepository'
import { resetSyncingDrafts } from './draftDb'
import { syncStoredDrafts } from './syncDrafts'

// One shared promise per page load, so a StrictMode double mount cannot sync before the reset has finished.
let startup: Promise<void> | null = null

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
    startup ??= resetSyncingDrafts().catch(() => undefined)
    void startup.then(syncNow)
    const onOnline = () => void syncNow()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [syncNow])

  return syncNow
}
