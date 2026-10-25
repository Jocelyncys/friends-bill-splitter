import { describe, expect, it } from 'vitest'
import { estimatePosition, positionFrom } from './myPosition'

describe('positionFrom', () => {
  const transfers = [
    { payerId: 'me', receiverId: 'ana', amountCents: 3000 },
    { payerId: 'ben', receiverId: 'me', amountCents: 1500 },
    { payerId: 'ben', receiverId: 'ana', amountCents: 700 },
  ]

  it('splits my transfers into what I owe and what I get back', () => {
    expect(positionFrom(transfers, 'me')).toEqual({
      owe: [{ userId: 'ana', amountCents: 3000 }],
      receive: [{ userId: 'ben', amountCents: 1500 }],
    })
  })

  it('is all square when no transfer involves me', () => {
    expect(positionFrom(transfers, 'cat')).toEqual({ owe: [], receive: [] })
  })
})

describe('estimatePosition', () => {
  it('uses the optimized direct plan from the settlement totals', () => {
    const totals = [
      { userId: 'ana', paidCents: 12000, owedCents: 4000 },
      { userId: 'ben', paidCents: 0, owedCents: 4000 },
      { userId: 'me', paidCents: 0, owedCents: 4000 },
    ]
    expect(estimatePosition({ totals, unresolved: [] }, 'me')).toEqual({ owe: [{ userId: 'ana', amountCents: 4000 }], receive: [] })
  })

  it('waits while any expense is not fully assigned', () => {
    const totals = [{ userId: 'ana', paidCents: 1000, owedCents: 0 }]
    expect(estimatePosition({ totals, unresolved: [{ expenseId: 'x' }] }, 'me')).toBe('waiting')
  })

  it('is all square with no expenses', () => {
    expect(estimatePosition({ totals: [], unresolved: [] }, 'me')).toEqual({ owe: [], receive: [] })
  })
})
