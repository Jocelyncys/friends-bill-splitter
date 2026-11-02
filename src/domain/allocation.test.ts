import { describe, expect, it } from 'vitest'
import { allocateByUnits, allocateEqual, allocateProportionally, itemShares, validateCustomAllocation } from './allocation'
import type { AllocationMap } from './types'

describe('allocation', () => {
  it('assigns rounding cents deterministically', () => {
    expect(allocateEqual(1000, ['alice', 'ben', 'cara'])).toEqual({ alice: 334, ben: 333, cara: 333 })
  })

  it('rejects custom totals that do not equal the expense', () => {
    expect(validateCustomAllocation(1000, { alice: 500, ben: 499 })).toEqual({ valid: false, difference: 1 })
  })

  it('allocates tax proportionally and preserves every cent', () => {
    expect(allocateProportionally(101, { alice: 700, ben: 300 })).toEqual({ alice: 71, ben: 30 })
  })

  it('allocateEqual throws on empty participants, negative total, or non-integer total', () => {
    expect(() => allocateEqual(1000, [])).toThrow('Invalid equal allocation')
    expect(() => allocateEqual(-1, ['alice'])).toThrow('Invalid equal allocation')
    expect(() => allocateEqual(10.5, ['alice'])).toThrow('Invalid equal allocation')
  })

  it('validateCustomAllocation rejects negative or non-integer shares even when they sum to the total', () => {
    expect(validateCustomAllocation(1000, { alice: -100, ben: 1100 }).valid).toBe(false)
    expect(validateCustomAllocation(1000, { alice: 500.5, ben: 499.5 }).valid).toBe(false)
  })

  it('allocateProportionally falls back to an equal split when all weights are 0', () => {
    expect(allocateProportionally(10, { alice: 0, ben: 0 })).toEqual({ alice: 5, ben: 5 })
  })

  it('allocateProportionally output always sums to the total', () => {
    const weightSets: AllocationMap[] = [
      { alice: 1, ben: 1, cara: 1 },
      { alice: 333, ben: 271, cara: 19 },
      { alice: 1, ben: 2, cara: 3, dan: 4 },
    ]
    for (const total of [0, 1, 7, 100, 9999]) {
      for (const weights of weightSets) {
        const result = allocateProportionally(total, weights)
        const sum = Object.values(result).reduce((acc, value) => acc + value, 0)
        expect(sum).toBe(total)
      }
    }
  })

  it('allocateEqual throws on duplicate participant ids', () => {
    expect(() => allocateEqual(100, ['a', 'a', 'b'])).toThrow('Invalid equal allocation')
  })

  it('allocateProportionally validates total and weights up front', () => {
    expect(() => allocateProportionally(-1, { a: 1 })).toThrow('Invalid proportional allocation')
    expect(() => allocateProportionally(1.5, { a: 1 })).toThrow('Invalid proportional allocation')
    expect(() => allocateProportionally(10, { a: -1, b: 2 })).toThrow('Invalid proportional allocation')
    expect(() => allocateProportionally(10, { a: 1.5 })).toThrow('Invalid proportional allocation')
    expect(() => allocateProportionally(10, {})).toThrow('Invalid proportional allocation')
  })

  it('allocateProportionally breaks exact-remainder ties by ascending id', () => {
    expect(allocateProportionally(1, { a: 1, b: 1, c: 1 })).toEqual({ a: 1, b: 0, c: 0 })
  })

  it('allocateProportionally stays exact for products beyond MAX_SAFE_INTEGER', () => {
    const total = 9_007_199_254_740_991
    const result = allocateProportionally(total, { a: 3, b: 1 })
    expect(result.a + result.b).toBe(total)
    expect(result).toEqual({ a: 6_755_399_441_055_743, b: 2_251_799_813_685_248 })
  })

  it('validateCustomAllocation treats a negative or non-safe-integer total as invalid', () => {
    expect(validateCustomAllocation(-100, { a: -100 }).valid).toBe(false)
    expect(validateCustomAllocation(10.5, { a: 10.5 }).valid).toBe(false)
    expect(validateCustomAllocation(-1, {}).valid).toBe(false)
  })
})

describe('allocateByUnits (claim by unit)', () => {
  it('splits 3 x 10.00 = 1000 over 2/1 units as 667/333', () => {
    expect(allocateByUnits(1000, 3, { ben: 1, ali: 2 })).toEqual({ ali: 667, ben: 333 })
  })

  it('splits 2 x 3.50 = 700 one unit each as 350/350', () => {
    expect(allocateByUnits(700, 2, { ali: 1, ben: 1 })).toEqual({ ali: 350, ben: 350 })
  })

  it('gives equal remainders to the lowest id (code-point order)', () => {
    expect(allocateByUnits(1000, 3, { c: 1, B: 1, a: 1 })).toEqual({ B: 334, a: 333, c: 333 })
  })

  it('gives each claimer the floor of their units while units are left, the rest stays unallocated', () => {
    expect(allocateByUnits(1000, 3, { ali: 1 })).toEqual({ ali: 333 })
    expect(allocateByUnits(1000, 4, { ali: 1, ben: 2 })).toEqual({ ali: 250, ben: 500 })
  })

  it('rejects units over the quantity, non-positive or fractional units and a bad quantity', () => {
    expect(() => allocateByUnits(1000, 3, { ali: 2, ben: 2 })).toThrow()
    expect(() => allocateByUnits(1000, 3, { ali: 0 })).toThrow()
    expect(() => allocateByUnits(1000, 3, { ali: 1.5 })).toThrow()
    expect(() => allocateByUnits(1000, 0, { ali: 1 })).toThrow()
  })
})

describe('itemShares', () => {
  it('splits a quantity 1 item equally and a quantity > 1 item by units', () => {
    expect(itemShares({ totalCents: 1001, quantity: 1 }, ['b', 'a'])).toEqual({ a: 501, b: 500 })
    expect(itemShares({ totalCents: 1000, quantity: 3 }, ['a', 'b'], { a: 2, b: 1 })).toEqual({ a: 667, b: 333 })
  })

  it('splits equally when any claimer has no unit count (claims from before units), like the server', () => {
    expect(itemShares({ totalCents: 700, quantity: 2 }, ['a', 'b'])).toEqual({ a: 350, b: 350 })
    expect(itemShares({ totalCents: 1000, quantity: 3 }, ['a', 'b'], { a: 2 })).toEqual({ a: 500, b: 500 })
  })

  it('returns no shares for nobody', () => {
    expect(itemShares({ totalCents: 700, quantity: 2 }, [])).toEqual({})
    expect(itemShares({ totalCents: 700, quantity: 1 }, [])).toEqual({})
  })
})
