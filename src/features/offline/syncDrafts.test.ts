import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExpenseSaveError, type SaveExpensePayload } from '../expenses/expenseRepository'

const db = vi.hoisted(() => ({
  listPendingDrafts: vi.fn(),
  markDrafts: vi.fn(),
  deleteDraft: vi.fn(),
  setDraftStatus: vi.fn(),
}))
vi.mock('./draftDb', () => db)

import { syncPendingDrafts, syncStoredDrafts } from './syncDrafts'

const validPayload: SaveExpensePayload = {
  id: 'draft-1',
  eventId: 'ev-1',
  payerUserId: 'u-a',
  description: 'Dinner',
  expenseDate: '2026-10-25',
  totalCents: 1000,
  splitMethod: 'equal',
  items: [],
  allocations: [{ itemId: null, participantUserId: 'u-a', amountCents: 1000 }],
}

const draft = (id: string) => ({ id, eventId: 'ev-1', status: 'pending' as const, payload: { ...validPayload, id }, updatedAt: 1 })

describe('syncPendingDrafts', () => {
  it('marks a draft synced without creating a second expense on retry', async () => {
    const saveExpense = vi.fn().mockResolvedValue({ id: 'draft-1' })
    await syncPendingDrafts([{ id: 'draft-1', status: 'pending', payload: validPayload }], saveExpense)
    expect(saveExpense).toHaveBeenCalledTimes(1)
    expect(saveExpense).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft-1' }))
  })

  it('classifies success, server rejection and network failure per draft', async () => {
    const saveExpense = vi
      .fn()
      .mockResolvedValueOnce({ id: 'a' })
      .mockRejectedValueOnce(new ExpenseSaveError({ code: 'event_not_open' }, new Error('x')))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ExpenseSaveError({ code: 'save_failed' }, new Error('x')))
    const results = await syncPendingDrafts(['a', 'b', 'c', 'd'].map(draft), saveExpense)
    expect(results).toEqual([
      { id: 'a', outcome: 'synced' },
      { id: 'b', outcome: 'failed', code: 'event_not_open' },
      { id: 'c', outcome: 'pending' },
      { id: 'd', outcome: 'pending' },
    ])
  })
})

describe('syncStoredDrafts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.markDrafts.mockResolvedValue(undefined)
    db.deleteDraft.mockResolvedValue(undefined)
    db.setDraftStatus.mockResolvedValue(undefined)
  })

  it('marks drafts syncing before sending, deletes synced ones and keeps the rest', async () => {
    db.listPendingDrafts.mockResolvedValue([draft('a'), draft('b'), draft('c')])
    const saveExpense = vi
      .fn()
      .mockResolvedValueOnce({ id: 'a' })
      .mockRejectedValueOnce(new ExpenseSaveError({ code: 'invalid_total' }, new Error('x')))
      .mockRejectedValueOnce(new TypeError('offline'))
    const synced = await syncStoredDrafts(saveExpense)
    expect(synced).toBe(1)
    expect(db.markDrafts).toHaveBeenCalledWith(['a', 'b', 'c'], 'syncing')
    expect(db.markDrafts.mock.invocationCallOrder[0]).toBeLessThan(saveExpense.mock.invocationCallOrder[0])
    expect(db.deleteDraft).toHaveBeenCalledWith('a')
    expect(db.setDraftStatus).toHaveBeenCalledWith('b', 'failed', 'invalid_total')
    expect(db.setDraftStatus).toHaveBeenCalledWith('c', 'pending')
  })

  it('never runs two syncs at once, so a draft is not sent twice', async () => {
    db.listPendingDrafts.mockResolvedValue([draft('a')])
    let release: () => void = () => undefined
    const saveExpense = vi.fn().mockImplementation(() => new Promise<{ id: string }>(resolve => (release = () => resolve({ id: 'a' }))))
    const first = syncStoredDrafts(saveExpense)
    const second = syncStoredDrafts(saveExpense)
    await vi.waitFor(() => expect(saveExpense).toHaveBeenCalledTimes(1))
    release()
    await Promise.all([first, second])
    expect(saveExpense).toHaveBeenCalledTimes(1)
  })
})
