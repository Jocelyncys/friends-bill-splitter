import Dexie, { liveQuery, type EntityTable } from 'dexie'
import type { SaveExpensePayload } from '../expenses/expenseRepository'

export type DraftStatus = 'pending' | 'syncing' | 'failed'

// The draft id is the expense id: the server uses it as the primary key, so a retry can never
// create a second expense. Receipt images are never stored here, only the reviewed payload.
export type ExpenseDraft = {
  id: string
  eventId: string
  payload: SaveExpensePayload
  status: DraftStatus
  errorCode?: string // why it failed: a server verdict, or 'too_many_attempts'
  attempts?: number // transient failures so far
  updatedAt: number
}

export const draftDb = new Dexie('friends-bill-splitter') as Dexie & { expenseDrafts: EntityTable<ExpenseDraft, 'id'> }
draftDb.version(1).stores({ expenseDrafts: 'id,eventId,status,updatedAt' })
// v2 adds `attempts` (not indexed): same stores, existing drafts start at 0.
draftDb
  .version(2)
  .stores({ expenseDrafts: 'id,eventId,status,updatedAt' })
  .upgrade(tx => tx.table('expenseDrafts').toCollection().modify(draft => void (draft.attempts ??= 0)))

export async function saveDraft(payload: SaveExpensePayload) {
  await draftDb.expenseDrafts.put({ id: payload.id, eventId: payload.eventId, payload, status: 'pending', updatedAt: Date.now() })
}

/** Everything not yet on the server (pending, syncing, failed), oldest first; optionally one event. */
export async function listDrafts(eventId?: string): Promise<ExpenseDraft[]> {
  const drafts = await (eventId ? draftDb.expenseDrafts.where('eventId').equals(eventId) : draftDb.expenseDrafts).toArray()
  return drafts.sort((a, b) => a.updatedAt - b.updatedAt)
}

/**
 * Calls `next` with the current list now and after every change, including changes made in other tabs.
 * Reports `error` straight away when IndexedDB is missing (liveQuery would otherwise stay silent).
 */
export function watchDrafts(eventId: string | undefined, next: (drafts: ExpenseDraft[]) => void, error: () => void) {
  if (typeof indexedDB === 'undefined') {
    error()
    return () => undefined
  }
  const subscription = liveQuery(() => listDrafts(eventId)).subscribe({ next, error })
  return () => subscription.unsubscribe()
}

export const getDraft = (id: string) => draftDb.expenseDrafts.get(id)

/** Drafts waiting to be sent (not failed, not in flight). */
export async function listPendingDrafts(): Promise<ExpenseDraft[]> {
  return (await draftDb.expenseDrafts.where('status').equals('pending').toArray()).sort((a, b) => a.updatedAt - b.updatedAt)
}

export async function deleteDraft(id: string) {
  await draftDb.expenseDrafts.delete(id)
}

export async function setDraftStatus(id: string, status: DraftStatus, extra: { errorCode?: string; attempts?: number } = {}) {
  await draftDb.expenseDrafts.update(id, { status, errorCode: extra.errorCode, ...(extra.attempts === undefined ? {} : { attempts: extra.attempts }) })
}

export async function markDrafts(ids: string[], status: DraftStatus) {
  await draftDb.expenseDrafts.bulkUpdate(ids.map(id => ({ key: id, changes: { status, errorCode: undefined } })))
}

/**
 * A page closed mid-sync leaves drafts 'syncing' forever; call once on app start. With several tabs open this may
 * flip a draft another tab is sending back to 'pending'; that is safe only because save_expense is idempotent by id.
 */
export async function resetSyncingDrafts() {
  await draftDb.expenseDrafts.where('status').equals('syncing').modify({ status: 'pending' })
}
