import { ExpenseSaveError, type SaveExpensePayload } from '../expenses/expenseRepository'
import { deleteDraft, listPendingDrafts, markDrafts, setDraftStatus, type ExpenseDraft } from './draftDb'

type SaveExpense = (payload: SaveExpensePayload) => Promise<unknown>

export type SyncResult =
  | { id: string; outcome: 'synced' }
  | { id: string; outcome: 'pending'; attempts: number } // transport trouble: try again later
  | { id: string; outcome: 'failed'; code: string } // the server refused it: needs the user

/**
 * True when retrying later can succeed: the request never reached a verdict. `network_error` is a transport
 * failure; `not_authenticated` happens when sync starts before the anonymous session exists. `save_failed`
 * and every other ExpenseSaveError is a real server answer, so retrying would never change it.
 */
export const MAX_ATTEMPTS = 5

export const isTransientSaveError = (error: unknown) =>
  !(error instanceof ExpenseSaveError) || error.formError.code === 'network_error' || error.formError.code === 'not_authenticated'

export async function syncPendingDrafts(
  drafts: Array<Pick<ExpenseDraft, 'id' | 'status' | 'payload' | 'attempts'>>,
  saveExpense: SaveExpense,
): Promise<SyncResult[]> {
  const results: SyncResult[] = []
  for (const draft of drafts) {
    try {
      // The draft id is the expense id, so the server treats a repeated send as the same expense.
      await saveExpense({ ...draft.payload, id: draft.id })
      results.push({ id: draft.id, outcome: 'synced' })
    } catch (error) {
      const attempts = (draft.attempts ?? 0) + 1
      if (!isTransientSaveError(error)) results.push({ id: draft.id, outcome: 'failed', code: (error as ExpenseSaveError).formError.code })
      else if (attempts >= MAX_ATTEMPTS) results.push({ id: draft.id, outcome: 'failed', code: 'too_many_attempts' })
      else results.push({ id: draft.id, outcome: 'pending', attempts })
    }
  }
  return results
}

let inFlight: Promise<number> | null = null

/** Sends every pending draft and records the outcome. One run at a time; returns how many synced. */
export function syncStoredDrafts(saveExpense: SaveExpense): Promise<number> {
  inFlight ??= run(saveExpense).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function run(saveExpense: SaveExpense) {
  const drafts = await listPendingDrafts()
  if (drafts.length === 0) return 0
  const unsettled = new Set(drafts.map(d => d.id))
  try {
    await markDrafts([...unsettled], 'syncing')
    const results = await syncPendingDrafts(drafts, saveExpense)
    for (const result of results) {
      if (result.outcome === 'synced') await deleteDraft(result.id)
      else if (result.outcome === 'failed') await setDraftStatus(result.id, 'failed', { errorCode: result.code })
      else await setDraftStatus(result.id, 'pending', { attempts: result.attempts })
      unsettled.delete(result.id)
    }
    return results.filter(r => r.outcome === 'synced').length
  } finally {
    // A storage error mid-run must not leave drafts stuck in 'syncing'. A resend is harmless (idempotent id).
    for (const id of unsettled) await setDraftStatus(id, 'pending').catch(() => undefined)
  }
}
