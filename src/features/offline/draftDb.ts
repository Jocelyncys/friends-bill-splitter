import Dexie, { type EntityTable } from 'dexie'
import type { SaveExpensePayload } from '../expenses/expenseRepository'

export type DraftStatus = 'pending' | 'syncing' | 'failed'

// The draft id is the expense id: the server uses it as the primary key, so a retry can never
// create a second expense. Receipt images are never stored here, only the reviewed payload.
export type ExpenseDraft = {
  id: string
  eventId: string
  payload: SaveExpensePayload
  status: DraftStatus
  errorCode?: string // why the server refused it (status 'failed')
  updatedAt: number
}

export const draftDb = new Dexie('friends-bill-splitter') as Dexie & { expenseDrafts: EntityTable<ExpenseDraft, 'id'> }
draftDb.version(1).stores({ expenseDrafts: 'id,eventId,status,updatedAt' })

const listeners = new Set<() => void>()
const changed = () => listeners.forEach(listener => listener())

/** Calls back after every change made through this module (same tab). */
export function subscribeDrafts(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function saveDraft(payload: SaveExpensePayload) {
  await draftDb.expenseDrafts.put({ id: payload.id, eventId: payload.eventId, payload, status: 'pending', updatedAt: Date.now() })
  changed()
}

/** Everything not yet on the server (pending, syncing, failed), oldest first; optionally one event. */
export async function listDrafts(eventId?: string): Promise<ExpenseDraft[]> {
  const drafts = await (eventId ? draftDb.expenseDrafts.where('eventId').equals(eventId) : draftDb.expenseDrafts).toArray()
  return drafts.sort((a, b) => a.updatedAt - b.updatedAt)
}

export const getDraft = (id: string) => draftDb.expenseDrafts.get(id)

/** Drafts waiting to be sent (not failed, not in flight). */
export async function listPendingDrafts(): Promise<ExpenseDraft[]> {
  return (await draftDb.expenseDrafts.where('status').equals('pending').toArray()).sort((a, b) => a.updatedAt - b.updatedAt)
}

export async function deleteDraft(id: string) {
  await draftDb.expenseDrafts.delete(id)
  changed()
}

export async function setDraftStatus(id: string, status: DraftStatus, errorCode?: string) {
  await draftDb.expenseDrafts.update(id, { status, errorCode })
  changed()
}

export async function markDrafts(ids: string[], status: DraftStatus) {
  await draftDb.expenseDrafts.bulkUpdate(ids.map(id => ({ key: id, changes: { status, errorCode: undefined } })))
  changed()
}

/** A page closed mid-sync leaves drafts 'syncing' forever; call once on app start. */
export async function resetSyncingDrafts() {
  await draftDb.expenseDrafts.where('status').equals('syncing').modify({ status: 'pending' })
  changed()
}
