import { describe, expect, it, vi } from 'vitest'
import { calculateBalances, settleOptimizedDirect } from '../../domain/settlement'
import { SettlementError, createSettlementRepository, toSettlementErrorCode } from './settlementRepository'

type Result = { data: unknown; error: unknown }
type Builder = {
  select(): Builder
  eq(): Builder
  order(): Builder
  maybeSingle(): Builder
  single(): Builder
  then(resolve: (r: Result) => unknown): Promise<unknown>
}
function builder(result: Result): Builder {
  const b: Builder = {
    select: () => b, eq: () => b, order: () => b, maybeSingle: () => b, single: () => b,
    then: resolve => Promise.resolve(result).then(resolve),
  }
  return b
}
function fromTables(results: Record<string, Result>) {
  return vi.fn((table: string) => builder(results[table]))
}
function owedRpc(rows: unknown, error: unknown = null) {
  return vi.fn().mockResolvedValue({ data: rows, error })
}

describe('settlementRepository.getSettlementInputs', () => {
  it('builds totals and payer allocations from the server owed shares, and unresolved from the items subtotal', async () => {
    const from = fromTables({
      events: { data: { revision: 7 }, error: null },
      event_members: {
        data: [
          { user_id: 'ali', display_name: 'Ali', role: 'owner' },
          { user_id: 'ben', display_name: 'Ben', role: 'participant' },
          { user_id: 'cara', display_name: 'Cara', role: 'participant' },
        ],
        error: null,
      },
      expenses: {
        data: [
          // Items 2857 fully allocated; voucher -500, SST +141, rounding +2 -> paid 2500.
          { id: 'e1', description: 'Dinner', payer_user_id: 'ali', total_cents: 2500,
            allocations: [{ amount_cents: 220 }, { amount_cents: 891 }, { amount_cents: 1746 }],
            expense_adjustments: [{ amount_cents: -500 }, { amount_cents: 141 }, { amount_cents: 2 }] },
          { id: 'e2', description: 'Snacks', payer_user_id: 'ben', total_cents: 500,
            allocations: [{ amount_cents: 200 }], expense_adjustments: [] },
          // Allocated 500 equals the paid total, but the items subtotal is 1000.
          { id: 'e3', description: 'Kopi', payer_user_id: 'cara', total_cents: 500,
            allocations: [{ amount_cents: 500 }], expense_adjustments: [{ amount_cents: -500 }] },
        ],
        error: null,
      },
    })
    const rpc = owedRpc([
      { expense_id: 'e1', payer_user_id: 'ali', participant_user_id: 'ali', owed_cents: 972 },
      { expense_id: 'e1', payer_user_id: 'ali', participant_user_id: 'ben', owed_cents: 1528 },
      { expense_id: 'e2', payer_user_id: 'ben', participant_user_id: 'ben', owed_cents: 200 },
      { expense_id: 'e3', payer_user_id: 'cara', participant_user_id: 'ali', owed_cents: 500 },
    ])
    const inputs = await createSettlementRepository({ from, rpc } as never).getSettlementInputs('event-1')
    expect(inputs).toEqual({
      revision: 7,
      members: [
        { userId: 'ali', displayName: 'Ali', role: 'owner' },
        { userId: 'ben', displayName: 'Ben', role: 'participant' },
        { userId: 'cara', displayName: 'Cara', role: 'participant' },
      ],
      totals: [
        { userId: 'ali', paidCents: 2500, owedCents: 1472 },
        { userId: 'ben', paidCents: 500, owedCents: 1728 },
        { userId: 'cara', paidCents: 500, owedCents: 0 },
      ],
      payerAllocations: [
        { expenseId: 'e1', payerId: 'ali', participantId: 'ali', amountCents: 972 },
        { expenseId: 'e1', payerId: 'ali', participantId: 'ben', amountCents: 1528 },
        { expenseId: 'e2', payerId: 'ben', participantId: 'ben', amountCents: 200 },
        { expenseId: 'e3', payerId: 'cara', participantId: 'ali', amountCents: 500 },
      ],
      unresolved: [
        { expenseId: 'e2', description: 'Snacks', unallocatedCents: 300 },
        { expenseId: 'e3', description: 'Kopi', unallocatedCents: 500 },
      ],
    })
    expect(from.mock.calls.map(c => c[0])).toEqual(['events', 'event_members', 'expenses'])
    expect(rpc).toHaveBeenCalledWith('get_event_owed_shares', { event_id: 'event-1' })
  })

  it('feeds the Task 8 functions once every expense is resolved', async () => {
    const from = fromTables({
      events: { data: { revision: 1 }, error: null },
      event_members: { data: [], error: null },
      expenses: {
        data: [{ id: 'e1', description: 'x', payer_user_id: 'a', total_cents: 100,
          allocations: [{ amount_cents: 50 }, { amount_cents: 50 }], expense_adjustments: [] }],
        error: null,
      },
    })
    const rpc = owedRpc([
      { expense_id: 'e1', payer_user_id: 'a', participant_user_id: 'a', owed_cents: 50 },
      { expense_id: 'e1', payer_user_id: 'a', participant_user_id: 'b', owed_cents: 50 },
    ])
    const { totals, unresolved } = await createSettlementRepository({ from, rpc } as never).getSettlementInputs('event-1')
    expect(unresolved).toEqual([])
    expect(settleOptimizedDirect(calculateBalances(totals))).toEqual([{ payerId: 'b', receiverId: 'a', amountCents: 50 }])
  })

  it('reads the revision before members, expenses and owed shares, and filters every read by event id', async () => {
    const log: string[] = []
    const from = vi.fn((table: string) => {
      log.push(`from:${table}`)
      const result: Result = table === 'events' ? { data: { revision: 3 }, error: null } : { data: [], error: null }
      const b: Builder = {
        select: () => b, order: () => b, maybeSingle: () => b, single: () => b,
        eq: ((column: string, value: string) => { log.push(`eq:${table}.${column}=${value}`); return b }) as never,
        then: resolve => Promise.resolve(result).then(r => { log.push(`resolved:${table}`); return resolve(r) }),
      }
      return b
    })
    const rpc = vi.fn((fn: string) => {
      log.push(`rpc:${fn}`)
      return Promise.resolve({ data: [], error: null })
    })
    await createSettlementRepository({ from, rpc } as never).getSettlementInputs('event-1')
    expect(log.indexOf('resolved:events')).toBeGreaterThan(-1)
    expect(log.indexOf('resolved:events')).toBeLessThan(log.indexOf('from:expenses'))
    expect(log.indexOf('resolved:events')).toBeLessThan(log.indexOf('from:event_members'))
    expect(log.indexOf('resolved:events')).toBeLessThan(log.indexOf('rpc:get_event_owed_shares'))
    expect(log).toEqual(expect.arrayContaining([
      'eq:events.id=event-1', 'eq:event_members.event_id=event-1', 'eq:expenses.event_id=event-1',
    ]))
  })

  it('maps a failed read to action_failed', async () => {
    const from = fromTables({
      events: { data: null, error: { code: '500', message: 'boom' } },
      event_members: { data: [], error: null },
      expenses: { data: [], error: null },
    })
    await expect(createSettlementRepository({ from, rpc: owedRpc([]) } as never).getSettlementInputs('event-1'))
      .rejects.toMatchObject({ code: 'action_failed' })
  })

  it('maps a failed owed-shares rpc to action_failed', async () => {
    const from = fromTables({
      events: { data: { revision: 1 }, error: null },
      event_members: { data: [], error: null },
      expenses: { data: [], error: null },
    })
    const rpc = owedRpc(null, { code: '22023', message: 'not_allowed' })
    await expect(createSettlementRepository({ from, rpc } as never).getSettlementInputs('event-1'))
      .rejects.toMatchObject({ code: 'action_failed' })
  })
})

describe('settlementRepository.confirmSettlement', () => {
  it('calls confirm_settlement with snake_case args and returns the settlement id', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'settlement-1', error: null })
    const repository = createSettlementRepository({ rpc } as never)
    await expect(repository.confirmSettlement({ eventId: 'event-1', method: 'coordinator', coordinatorId: 'ali', expectedRevision: 7 }))
      .resolves.toBe('settlement-1')
    await repository.confirmSettlement({ eventId: 'event-1', method: 'optimized_direct', expectedRevision: 8 })
    expect(rpc.mock.calls).toEqual([
      ['confirm_settlement', { event_id: 'event-1', method: 'coordinator', coordinator_id: 'ali', expected_revision: 7 }],
      ['confirm_settlement', { event_id: 'event-1', method: 'optimized_direct', coordinator_id: null, expected_revision: 8 }],
    ])
  })

  it('maps stale_revision (40001) and 22023 keys to typed errors', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: '40001', message: 'stale_revision' } })
      .mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'unresolved_expenses' } })
    const repository = createSettlementRepository({ rpc } as never)
    const input = { eventId: 'e', method: 'optimized_direct' as const, expectedRevision: 1 }
    const error = await repository.confirmSettlement(input).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SettlementError)
    expect((error as SettlementError).code).toBe('stale_revision')
    await expect(repository.confirmSettlement(input)).rejects.toMatchObject({ code: 'unresolved_expenses' })
  })

  it('maps unknown and auth errors', () => {
    expect(toSettlementErrorCode({ code: '22023', message: 'coordinator_not_creditor' })).toBe('coordinator_not_creditor')
    expect(toSettlementErrorCode({ code: '22023', message: 'invalid_reason' })).toBe('invalid_reason')
    expect(toSettlementErrorCode({ code: '22023', message: 'nope' })).toBe('action_failed')
    expect(toSettlementErrorCode({ code: '40001', message: 'could not serialize' })).toBe('action_failed')
    expect(toSettlementErrorCode({ code: '28000', message: 'not_authenticated' })).toBe('not_authenticated')
  })
})

describe('settlementRepository.getSettlement', () => {
  it('returns the snapshot in camelCase with transfers in ordinal (generation) order', async () => {
    const from = fromTables({
      settlements: {
        data: {
          id: 's1', method: 'coordinator', coordinator_user_id: 'ali', confirmed_by: 'ben', confirmed_at: '2026-10-25T00:00:00Z',
          settlement_balances: [
            { user_id: 'cara', paid_cents: 0, owed_cents: 600, net_cents: -600 },
            { user_id: 'ali', paid_cents: 900, owed_cents: 300, net_cents: 600 },
          ],
          settlement_transfers: [
            { id: 't1', payer_user_id: 'ali', receiver_user_id: 'ben', amount_cents: 100, state: 'pending', updated_at: 'u1', ordinal: 2 },
            { id: 't2', payer_user_id: 'cara', receiver_user_id: 'ali', amount_cents: 600, state: 'sent', updated_at: 'u2', ordinal: 1 },
          ],
        },
        error: null,
      },
    })
    await expect(createSettlementRepository({ from } as never).getSettlement('event-1')).resolves.toEqual({
      id: 's1', method: 'coordinator', coordinatorId: 'ali', confirmedBy: 'ben', confirmedAt: '2026-10-25T00:00:00Z',
      balances: [
        { userId: 'ali', paidCents: 900, owedCents: 300, netCents: 600 },
        { userId: 'cara', paidCents: 0, owedCents: 600, netCents: -600 },
      ],
      transfers: [
        { id: 't2', payerId: 'cara', receiverId: 'ali', amountCents: 600, state: 'sent', updatedAt: 'u2' },
        { id: 't1', payerId: 'ali', receiverId: 'ben', amountCents: 100, state: 'pending', updatedAt: 'u1' },
      ],
    })
  })

  it('returns null before the event is settled', async () => {
    const from = fromTables({ settlements: { data: null, error: null } })
    await expect(createSettlementRepository({ from } as never).getSettlement('event-1')).resolves.toBeNull()
  })
})
