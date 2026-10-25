import { describe, expect, it } from 'vitest'
import { allocateEqual, owedShares } from './allocation'
import { calculateBalances, settleOptimizedDirect, settleOriginalPayers, settleViaCoordinator, type PayerAllocation } from './settlement'

// Same fixtures as the Batch 2A section of supabase/tests/rls.sql (server is authoritative).
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const C = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

describe('owedShares', () => {
  it('splits the paid total over item subtotals: the real receipt', () => {
    // Ali 220 + 891, Ben 531 + 864 + 351; voucher -500, SST +141, rounding +2 -> paid 2500.
    expect(owedShares(2500, { ali: 220 + 891, ben: 531 + 864 + 351 })).toEqual({ ali: 972, ben: 1528 })
  })

  it('counts a shared item toward every sharer', () => {
    const shared = allocateEqual(1001, [C, A, B])
    expect(shared).toEqual({ [A]: 334, [B]: 334, [C]: 333 })
    const subtotals = { [A]: shared[A] + 700, [B]: shared[B] + 999, [C]: shared[C] }
    expect(owedShares(2562, subtotals)).toEqual({ [A]: 981, [B]: 1265, [C]: 316 })
  })

  it('returns the item subtotals unchanged when there are no adjustments', () => {
    expect(owedShares(1501, { a: 1001, b: 500 })).toEqual({ a: 1001, b: 500 })
  })

  it('always sums to the paid total', () => {
    const shares = owedShares(9999, { a: 1, b: 2, c: 3, d: 4 })
    expect(Object.values(shares).reduce((s, v) => s + v, 0)).toBe(9999)
  })

  it('feeds the settlement functions with the same results as confirm_settlement', () => {
    const rows: PayerAllocation[] = [
      ...Object.entries(owedShares(2500, { [A]: 1111, [B]: 1746 })).map(([participantId, amountCents]) => ({
        expenseId: 'y', payerId: A, participantId, amountCents,
      })),
      ...Object.entries(owedShares(2562, { [A]: 1034, [B]: 1333, [C]: 333 })).map(([participantId, amountCents]) => ({
        expenseId: 'z', payerId: B, participantId, amountCents,
      })),
    ]
    const owed: Record<string, number> = {}
    for (const r of rows) owed[r.participantId] = (owed[r.participantId] ?? 0) + r.amountCents
    const balances = calculateBalances([
      { userId: A, paidCents: 2500, owedCents: owed[A] },
      { userId: B, paidCents: 2562, owedCents: owed[B] },
      { userId: C, paidCents: 0, owedCents: owed[C] },
    ])
    expect(balances).toEqual({ [A]: 547, [B]: -231, [C]: -316 })
    expect(settleOriginalPayers(rows)).toEqual([
      { payerId: A, receiverId: B, amountCents: 981 },
      { payerId: B, receiverId: A, amountCents: 1528 },
      { payerId: C, receiverId: B, amountCents: 316 },
    ])
    expect(settleOptimizedDirect(balances)).toEqual([
      { payerId: C, receiverId: A, amountCents: 316 },
      { payerId: B, receiverId: A, amountCents: 231 },
    ])
    expect(settleViaCoordinator(balances, A)).toEqual([
      { payerId: B, receiverId: A, amountCents: 231 },
      { payerId: C, receiverId: A, amountCents: 316 },
    ])
  })
})
