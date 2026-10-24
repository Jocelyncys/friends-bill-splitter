import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  calculateBalances,
  settleOptimizedDirect,
  settleOriginalPayers,
  settleViaCoordinator,
  type PayerAllocation,
  type Transfer,
} from './settlement'

const totals = [
  { userId: 'ali', paidCents: 80000, owedCents: 25000 },
  { userId: 'ben', paidCents: 30000, owedCents: 20000 },
  { userId: 'cara', paidCents: 0, owedCents: 35000 },
  { userId: 'dan', paidCents: 0, owedCents: 30000 },
]

describe('settlement', () => {
  it('calculates zero-sum balances', () => {
    expect(calculateBalances(totals)).toEqual({ ali: 55000, ben: 10000, cara: -35000, dan: -30000 })
  })

  it('rejects invalid totals', () => {
    expect(() => calculateBalances([{ userId: 'a', paidCents: 100, owedCents: 0 }])).toThrow('sum to zero')
    expect(() => calculateBalances([{ userId: 'a', paidCents: -1, owedCents: 0 }])).toThrow()
    expect(() => calculateBalances([{ userId: 'a', paidCents: 1.5, owedCents: 1.5 }])).toThrow()
    expect(() => calculateBalances([
      { userId: 'a', paidCents: 0, owedCents: 0 },
      { userId: 'a', paidCents: 0, owedCents: 0 },
    ])).toThrow('Duplicate')
  })

  it('creates valid optimized direct transfers', () => {
    expect(settleOptimizedDirect(calculateBalances(totals))).toEqual([
      { payerId: 'cara', receiverId: 'ali', amountCents: 35000 },
      { payerId: 'dan', receiverId: 'ali', amountCents: 20000 },
      { payerId: 'dan', receiverId: 'ben', amountCents: 10000 },
    ])
  })

  it('routes settlement through the selected positive-balance coordinator', () => {
    expect(settleViaCoordinator(calculateBalances(totals), 'ali')).toEqual([
      { payerId: 'cara', receiverId: 'ali', amountCents: 35000 },
      { payerId: 'dan', receiverId: 'ali', amountCents: 30000 },
      { payerId: 'ali', receiverId: 'ben', amountCents: 10000 },
    ])
  })

  it('rejects a coordinator who is not a net creditor', () => {
    const balances = calculateBalances(totals)
    expect(() => settleViaCoordinator(balances, 'cara')).toThrow('net creditor')
    expect(() => settleViaCoordinator(balances, 'nobody')).toThrow('net creditor')
  })

  it('rejects invalid balances', () => {
    expect(() => settleOptimizedDirect({ a: 1 })).toThrow()
    expect(() => settleOptimizedDirect({ a: 1.5, b: -1.5 })).toThrow()
    expect(() => settleViaCoordinator({ a: 1 }, 'a')).toThrow()
  })

  it('settles with original payers across expenses with different payers', () => {
    const rows: PayerAllocation[] = [
      { expenseId: 'e1', payerId: 'ali', participantId: 'ali', amountCents: 2500 },
      { expenseId: 'e1', payerId: 'ali', participantId: 'ben', amountCents: 2500 },
      { expenseId: 'e1', payerId: 'ali', participantId: 'cara', amountCents: 2500 },
      { expenseId: 'e2', payerId: 'ben', participantId: 'ali', amountCents: 1000 },
      { expenseId: 'e2', payerId: 'ben', participantId: 'ben', amountCents: 1000 },
      { expenseId: 'e2', payerId: 'ben', participantId: 'cara', amountCents: 1000 },
      { expenseId: 'e3', payerId: 'ali', participantId: 'cara', amountCents: 500 },
      { expenseId: 'e3', payerId: 'ali', participantId: 'ben', amountCents: 0 },
    ]
    // The participant pays the payer of the expense; opposite pairs are deliberately not netted.
    expect(settleOriginalPayers(rows)).toEqual([
      { payerId: 'ali', receiverId: 'ben', amountCents: 1000 },
      { payerId: 'ben', receiverId: 'ali', amountCents: 2500 },
      { payerId: 'cara', receiverId: 'ali', amountCents: 3000 },
      { payerId: 'cara', receiverId: 'ben', amountCents: 1000 },
    ])
  })

  it('rejects invalid original-payer rows', () => {
    const row = { expenseId: 'e', payerId: 'a', participantId: 'b' }
    expect(() => settleOriginalPayers([{ ...row, amountCents: -1 }])).toThrow()
    expect(() => settleOriginalPayers([{ ...row, amountCents: 1.5 }])).toThrow()
  })
})

// ---- property tests ----

const runs = { numRuns: 100 }
const ids = ['a', 'b', 'c', 'd', 'e', 'f']

// Sending a transfer raises the sender's balance and lowers the receiver's.
function applyTransfers(balances: Record<string, number>, transfers: Transfer[]): Record<string, number> {
  const result = { ...balances }
  for (const t of transfers) {
    result[t.payerId] = (result[t.payerId] ?? 0) + t.amountCents
    result[t.receiverId] = (result[t.receiverId] ?? 0) - t.amountCents
  }
  return result
}

function expectWellFormed(transfers: Transfer[]) {
  for (const t of transfers) {
    expect(t.payerId).not.toBe(t.receiverId)
    expect(Number.isSafeInteger(t.amountCents)).toBe(true)
    expect(t.amountCents).toBeGreaterThan(0)
  }
}

// Zero-sum balances over unique ids; the last user absorbs the remainder.
const balancesArb = fc
  .tuple(
    fc.shuffledSubarray(ids, { minLength: 1 }),
    fc.array(fc.integer({ min: -100000, max: 100000 }), { minLength: ids.length, maxLength: ids.length }),
  )
  .map(([users, values]) => {
    const balances: Record<string, number> = {}
    let sum = 0
    users.slice(0, -1).forEach((id, i) => { balances[id] = values[i]; sum += values[i] })
    balances[users[users.length - 1]] = -sum
    return balances
  })

// Re-insert keys in a different order to prove output does not depend on it.
function reordered(balances: Record<string, number>, order: number[]): Record<string, number> {
  const entries = Object.entries(balances)
  entries.sort((x, y) => order[ids.indexOf(x[0])] - order[ids.indexOf(y[0])])
  return Object.fromEntries(entries)
}
const orderArb = fc.shuffledSubarray([0, 1, 2, 3, 4, 5], { minLength: 6, maxLength: 6 })
const allZero = (balances: Record<string, number>) => Object.values(balances).every(v => v === 0)

describe('settlement properties', () => {
  it('optimized direct: well formed, zeroes balances, order independent', () => {
    fc.assert(fc.property(balancesArb, orderArb, (balances, order) => {
      const transfers = settleOptimizedDirect(balances)
      expectWellFormed(transfers)
      expect(allZero(applyTransfers(balances, transfers))).toBe(true)
      expect(settleOptimizedDirect(reordered(balances, order))).toEqual(transfers)
    }), runs)
  })

  it('coordinator: well formed, zeroes balances, order independent', () => {
    fc.assert(fc.property(
      balancesArb.filter(b => Object.values(b).some(v => v > 0)),
      orderArb,
      fc.nat(),
      (balances, order, pick) => {
        const creditors = Object.keys(balances).filter(id => balances[id] > 0)
        const coordinator = creditors[pick % creditors.length]
        const transfers = settleViaCoordinator(balances, coordinator)
        expectWellFormed(transfers)
        expect(allZero(applyTransfers(balances, transfers))).toBe(true)
        expect(settleViaCoordinator(reordered(balances, order), coordinator)).toEqual(transfers)
      },
    ), runs)
  })

  it('original payers: well formed, zeroes balances derived from rows, order independent', () => {
    const rowArb = fc.record({
      expenseId: fc.constantFrom('e1', 'e2', 'e3'),
      payerId: fc.constantFrom(...ids),
      participantId: fc.constantFrom(...ids),
      amountCents: fc.integer({ min: 0, max: 100000 }),
    })
    fc.assert(fc.property(fc.array(rowArb, { maxLength: 30 }), (rows) => {
      const transfers = settleOriginalPayers(rows)
      expectWellFormed(transfers)
      // Derivation: the payer is credited each row amount, the participant debited it.
      const balances: Record<string, number> = {}
      for (const r of rows) {
        balances[r.payerId] = (balances[r.payerId] ?? 0) + r.amountCents
        balances[r.participantId] = (balances[r.participantId] ?? 0) - r.amountCents
      }
      expect(allZero(applyTransfers(balances, transfers))).toBe(true)
      expect(settleOriginalPayers([...rows].reverse())).toEqual(transfers)
    }), runs)
  })
})
