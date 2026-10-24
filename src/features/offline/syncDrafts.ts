import { ExpenseSaveError, type SaveExpensePayload } from '../expenses/expenseRepository'
import { deleteDraft, listPendingDrafts, markDrafts, setDraftStatus, type ExpenseDraft } from './draftDb'

type SaveExpense = (payload: SaveExpensePayload) => Promise<unknown>

export type SyncResult =
  | { id: string; outcome: 'synced' }
  | { id: string; outcome: 'pending' } // network / server trouble: try again later
  | { id: string; outcome: 'failed'; code: string } // the server refused it: needs the user

/**
 * True when retrying later can succeed: not a server verdict. `save_failed` is the repository's
 * catch-all for transport errors and unexpected server errors, so it counts as transient.
 */
export const isTransientSaveError = (error: unknown) => !(error instanceof ExpenseSaveError) || error.formError.code === 'save_failed'

export async function syncPendingDrafts(
  drafts: Array<Pick<ExpenseDraft, 'id' | 'status' | 'payload'>>,
  saveExpense: SaveExpense,
): Promise<SyncResult[]> {
  const results: SyncResult[] = []
  for (const draft of drafts) {
    try {
      // The draft id is the expense id, so the server treats a repeated send as the same expense.
      await saveExpense({ ...draft.payload, id: draft.id })
      results.push({ id: draft.id, outcome: 'synced' })
    } catch (error) {
      results.push(
        isTransientSaveError(error)
          ? { id: draft.id, outcome: 'pending' }
          : { id: draft.id, outcome: 'failed', code: (error as ExpenseSaveError).formError.code },
      )
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
  await markDrafts(drafts.map(d => d.id), 'syncing')
  const results = await syncPendingDrafts(drafts, saveExpense)
  for (const result of results) {
    if (result.outcome === 'synced') await deleteDraft(result.id)
    else if (result.outcome === 'failed') await setDraftStatus(result.id, 'failed', result.code)
    else await setDraftStatus(result.id, 'pending')
  }
  return results.filter(r => r.outcome === 'synced').length
}
