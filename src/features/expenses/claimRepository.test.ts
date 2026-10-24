import { describe, expect, it, vi } from 'vitest'
import { ActionError, createClaimRepository, toActionErrorCode } from './claimRepository'

type Result = { data: unknown; error: unknown }
type Builder = { select(): Builder; eq(): Builder; maybeSingle(): Builder; then(resolve: (r: Result) => unknown): Promise<unknown> }
function builder(result: Result): Builder {
  const b: Builder = { select: () => b, eq: () => b, maybeSingle: () => b, then: resolve => Promise.resolve(result).then(resolve) }
  return b
}

describe('claimRepository', () => {
  it('calls each rpc with its snake_case arguments', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const repository = createClaimRepository({ rpc } as never)
    await repository.claimItem('item-1')
    await repository.unclaimItem('item-1')
    await repository.assignItem('item-1', 'user-2')
    await repository.setClaimingClosed('exp-1', true)
    expect(rpc.mock.calls).toEqual([
      ['claim_item', { item_id: 'item-1' }],
      ['unclaim_item', { item_id: 'item-1' }],
      ['assign_item', { item_id: 'item-1', member_id: 'user-2' }],
      ['set_claiming_closed', { expense_id: 'exp-1', closed: true }],
    ])
  })

  it('maps 22023 keys to a typed error and unknown errors to action_failed', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'claiming_closed' } })
      .mockResolvedValueOnce({ data: null, error: { code: '08006', message: 'connection failure' } })
    const repository = createClaimRepository({ rpc } as never)
    const error = await repository.claimItem('item-1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ActionError)
    expect((error as ActionError).code).toBe('claiming_closed')
    await expect(repository.claimItem('item-1')).rejects.toMatchObject({ code: 'action_failed' })
  })

  it('maps auth and unknown 22023 messages', () => {
    expect(toActionErrorCode({ code: '28000', message: 'not_authenticated' })).toBe('not_authenticated')
    expect(toActionErrorCode({ code: '22023', message: 'something_else' })).toBe('action_failed')
    expect(toActionErrorCode({ code: '22023', message: 'invalid_role_change' })).toBe('invalid_role_change')
  })

  it('loads an expense with its items (sorted) and allocations in camelCase cents', async () => {
    const from = vi.fn(() => builder({
      data: {
        id: 'exp-1', event_id: 'event-1', creator_user_id: 'user-1', description: 'Dinner', total_cents: 1501,
        split_method: 'item_claim', claiming_closed: false,
        expense_items: [
          { id: 'item-2', description: 'Tea', quantity: 1, total_cents: 500, sort_order: 1 },
          { id: 'item-1', description: 'Rice', quantity: 2, total_cents: 1001, sort_order: 0 },
        ],
        allocations: [{ id: 'a-1', item_id: 'item-1', participant_user_id: 'user-2', amount_cents: 1001, source: 'self_claim' }],
      },
      error: null,
    }))
    const repository = createClaimRepository({ from } as never)
    await expect(repository.getExpenseClaims('exp-1')).resolves.toEqual({
      id: 'exp-1', eventId: 'event-1', creatorUserId: 'user-1', description: 'Dinner', totalCents: 1501,
      splitMethod: 'item_claim', claimingClosed: false,
      items: [
        { id: 'item-1', description: 'Rice', quantity: 2, totalCents: 1001, sortOrder: 0 },
        { id: 'item-2', description: 'Tea', quantity: 1, totalCents: 500, sortOrder: 1 },
      ],
      allocations: [{ id: 'a-1', itemId: 'item-1', participantUserId: 'user-2', amountCents: 1001, source: 'self_claim' }],
    })
    expect(from).toHaveBeenCalledWith('expenses')
  })

  it('rejects with expense_not_found when RLS returns no row', async () => {
    const from = vi.fn(() => builder({ data: null, error: null }))
    const repository = createClaimRepository({ from } as never)
    await expect(repository.getExpenseClaims('exp-x')).rejects.toMatchObject({ code: 'expense_not_found' })
  })
})

describe('getExpenseClaims read errors', () => {
  it('maps a failed read to a typed action_failed error', async () => {
    const from = vi.fn(() => builder({ data: null, error: { code: '500', message: 'boom' } }))
    const repository = createClaimRepository({ from } as never)
    const error = await repository.getExpenseClaims('exp-1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ActionError)
    expect((error as ActionError).code).toBe('action_failed')
  })
})
