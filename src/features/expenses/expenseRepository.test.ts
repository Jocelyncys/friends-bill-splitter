import { describe, expect, it, vi } from 'vitest'
import { createExpenseRepository, ExpenseSaveError, type SaveExpensePayload } from './expenseRepository'

const payload: SaveExpensePayload = {
  id: 'exp-1',
  eventId: 'event-1',
  payerUserId: 'user-1',
  description: 'Lunch',
  category: 'food',
  expenseDate: '2026-10-24',
  totalCents: 1000,
  splitMethod: 'item_claim',
  items: [{ id: 'item-1', description: 'Rice', quantity: 2, totalCents: 1000, sortOrder: 0 }],
  allocations: [{ itemId: 'item-1', participantUserId: 'user-2', amountCents: 400 }],
}

type Result = { data: unknown; error: unknown }
type Builder = { select(): Builder; eq(): Builder; order(): Builder; then(resolve: (r: Result) => unknown): Promise<unknown> }
function builder(result: Result): Builder {
  const b: Builder = { select: () => b, eq: () => b, order: () => b, then: resolve => Promise.resolve(result).then(resolve) }
  return b
}

describe('expenseRepository', () => {
  it('saves through the save_expense rpc with the snake_case payload and returns the id', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'exp-1', error: null })
    const repository = createExpenseRepository({ rpc } as never)
    await expect(repository.saveExpense(payload)).resolves.toEqual({ id: 'exp-1' })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('save_expense', {
      payload: {
        id: 'exp-1',
        event_id: 'event-1',
        payer_user_id: 'user-1',
        description: 'Lunch',
        category: 'food',
        expense_date: '2026-10-24',
        total_cents: 1000,
        split_method: 'item_claim',
        items: [{ id: 'item-1', description: 'Rice', quantity: 2, total_cents: 1000, sort_order: 0 }],
        allocations: [{ item_id: 'item-1', participant_user_id: 'user-2', amount_cents: 400 }],
        adjustments: [],
      },
    })
  })

  it('sends bill adjustments as snake_case rows', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'exp-1', error: null })
    await createExpenseRepository({ rpc } as never).saveExpense({
      ...payload,
      totalCents: 900,
      adjustments: [
        { id: 'adj-1', kind: 'discount', label: 'Voucher', amountCents: -150, sortOrder: 0 },
        { id: 'adj-2', kind: 'tax', label: 'SST', amountCents: 50, sortOrder: 1 },
      ],
    })
    expect(rpc.mock.calls[0][1].payload.adjustments).toEqual([
      { id: 'adj-1', kind: 'discount', label: 'Voucher', amount_cents: -150, sort_order: 0 },
      { id: 'adj-2', kind: 'tax', label: 'SST', amount_cents: 50, sort_order: 1 },
    ])
  })

  it.each(['invalid_adjustment', 'adjustments_not_allowed', 'adjustment_mismatch'])('maps %s to a form error on adjustments', async code => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '22023', message: code } })
    await expect(createExpenseRepository({ rpc } as never).saveExpense(payload)).rejects.toMatchObject({
      formError: { field: 'adjustments', code },
    })
  })

  it('maps a 22023 allocation_mismatch error to a form error on allocations', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '22023', message: 'allocation_mismatch' } })
    const repository = createExpenseRepository({ rpc } as never)
    const error = await repository.saveExpense(payload).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ExpenseSaveError)
    expect((error as ExpenseSaveError).formError).toEqual({ field: 'allocations', code: 'allocation_mismatch' })
  })

  it('maps form-level and unknown errors without a field', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'event_not_open' } })
      .mockResolvedValueOnce({ data: null, error: { code: '08006', message: 'connection failure' } })
    const repository = createExpenseRepository({ rpc } as never)
    await expect(repository.saveExpense(payload)).rejects.toMatchObject({ formError: { code: 'event_not_open' } })
    await expect(repository.saveExpense(payload)).rejects.toMatchObject({ formError: { code: 'save_failed' } })
  })

  it.each([
    ['fetch failure (status 0)', { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 }],
    ['fetch failure without status', { error: { code: '', message: 'TypeError: Failed to fetch' } }],
    ['gateway 502', { error: { code: '', message: 'Bad Gateway' }, status: 502 }],
    ['unavailable 503', { error: { code: 'PGRST000', message: 'down' }, status: 503 }],
    ['gateway timeout 504', { error: { code: '', message: 'timeout' }, status: 504 }],
  ])('reports a transport failure (%s) as network_error', async (_name, response) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, ...response })
    const repository = createExpenseRepository({ rpc } as never)
    await expect(repository.saveExpense(payload)).rejects.toMatchObject({ formError: { code: 'network_error' } })
  })

  it('keeps permission, constraint and server errors as a real save_failed verdict', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied' }, status: 403 })
      .mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'duplicate key' }, status: 409 })
      .mockResolvedValueOnce({ data: null, error: { code: 'XX000', message: 'boom' }, status: 500 })
    const repository = createExpenseRepository({ rpc } as never)
    for (let i = 0; i < 3; i++) await expect(repository.saveExpense(payload)).rejects.toMatchObject({ formError: { code: 'save_failed' } })
  })

  it('lists expenses newest first as summaries', async () => {
    const from = vi.fn(() => builder({
      data: [{ id: 'exp-1', description: 'Lunch', total_cents: 1000, payer_user_id: 'user-1', creator_user_id: 'user-3', split_method: 'equal', created_at: '2026-10-24T10:00:00Z' }],
      error: null,
    }))
    const repository = createExpenseRepository({ from } as never)
    await expect(repository.listExpenses('event-1')).resolves.toEqual([
      { id: 'exp-1', description: 'Lunch', totalCents: 1000, payerUserId: 'user-1', creatorUserId: 'user-3', splitMethod: 'equal', createdAt: '2026-10-24T10:00:00Z' },
    ])
    expect(from).toHaveBeenCalledWith('expenses')
  })

  it('loads a saved expense as a save payload, keeping self-claims out of the allocations', async () => {
    const row = {
      id: 'exp-1', event_id: 'event-1', creator_user_id: 'user-1', payer_user_id: 'user-1', description: 'Lunch', category: 'food',
      expense_date: '2026-10-24', total_cents: 1500, split_method: 'item_claim',
      expense_items: [
        { id: 'item-2', description: 'Tea', quantity: 1, total_cents: 500, sort_order: 1 },
        { id: 'item-1', description: 'Rice', quantity: 1, total_cents: 1000, sort_order: 0 },
      ],
      allocations: [
        { item_id: 'item-1', participant_user_id: 'user-2', amount_cents: 500, source: 'self_claim' },
        { item_id: 'item-1', participant_user_id: 'user-3', amount_cents: 500, source: 'self_claim' },
        { item_id: 'item-2', participant_user_id: 'user-1', amount_cents: 500, source: 'owner' },
      ],
      expense_adjustments: [
        { id: 'adj-2', kind: 'tax', label: 'SST', amount_cents: 90, sort_order: 1 },
        { id: 'adj-1', kind: 'discount', label: 'Voucher', amount_cents: -100, sort_order: 0 },
      ],
    }
    const maybeSingle = vi.fn().mockResolvedValue({ data: row, error: null })
    const eq = vi.fn(() => ({ maybeSingle }))
    const select = vi.fn(() => ({ eq }))
    const from = vi.fn(() => ({ select }))
    const repository = createExpenseRepository({ from } as never)
    await expect(repository.getExpense('exp-1')).resolves.toEqual({
      creatorUserId: 'user-1',
      claims: { 'item-1': ['user-2', 'user-3'] },
      payload: {
        id: 'exp-1', eventId: 'event-1', payerUserId: 'user-1', description: 'Lunch', category: 'food', expenseDate: '2026-10-24',
        totalCents: 1500, splitMethod: 'item_claim',
        items: [
          { id: 'item-1', description: 'Rice', quantity: 1, totalCents: 1000, sortOrder: 0 },
          { id: 'item-2', description: 'Tea', quantity: 1, totalCents: 500, sortOrder: 1 },
        ],
        allocations: [{ itemId: 'item-2', participantUserId: 'user-1', amountCents: 500 }],
        adjustments: [
          { id: 'adj-1', kind: 'discount', label: 'Voucher', amountCents: -100, sortOrder: 0 },
          { id: 'adj-2', kind: 'tax', label: 'SST', amountCents: 90, sortOrder: 1 },
        ],
      },
    })
    expect(select).toHaveBeenCalledWith(expect.stringContaining('expense_adjustments(id, kind, label, amount_cents, sort_order)'))
    expect(from).toHaveBeenCalledWith('expenses')
    expect(eq).toHaveBeenCalledWith('id', 'exp-1')
  })

  it('reports a missing expense as expense_not_found', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }))
    await expect(createExpenseRepository({ from } as never).getExpense('nope')).rejects.toThrow('expense_not_found')
  })

  it('deletes through the delete_expense rpc and maps its error keys', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'not_allowed' } })
    const repository = createExpenseRepository({ rpc } as never)
    await expect(repository.deleteExpense('exp-1')).resolves.toBeUndefined()
    expect(rpc).toHaveBeenCalledWith('delete_expense', { expense_id: 'exp-1' })
    await expect(repository.deleteExpense('exp-1')).rejects.toMatchObject({ formError: { code: 'not_allowed' } })
  })
})
