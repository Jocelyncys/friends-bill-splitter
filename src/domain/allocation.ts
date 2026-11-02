import type { AllocationMap } from './types'

// Plain code-point comparison so id ordering never depends on the runtime locale.
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function isCents(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Splits `total` cents equally. Remainder rule: the extra cents go one each to
 * the ids in ascending code-point order. Duplicate ids are rejected.
 */
export function allocateEqual(total: number, participantIds: string[]): AllocationMap {
  if (!isCents(total) || participantIds.length === 0 || new Set(participantIds).size !== participantIds.length) {
    throw new Error('Invalid equal allocation')
  }
  const ids = [...participantIds].sort(compareIds)
  const base = Math.floor(total / ids.length)
  let remainder = total - base * ids.length
  return Object.fromEntries(ids.map(id => [id, base + (remainder-- > 0 ? 1 : 0)]))
}

export function validateCustomAllocation(total: number, values: AllocationMap) {
  const allocated = Object.values(values).reduce((sum, value) => sum + value, 0)
  const nonNegativeIntegers = Object.values(values).every(isCents)
  return { valid: isCents(total) && nonNegativeIntegers && allocated === total, difference: total - allocated }
}

/**
 * Splits `total` cents in proportion to `weights` using exact integer math.
 * Remainder rule: each id gets floor(total * weight / weightTotal); leftover
 * cents go one each to the largest exact remainder first, ties by ascending id.
 * If every weight is 0 it falls back to allocateEqual.
 */
export function allocateProportionally(total: number, weights: AllocationMap): AllocationMap {
  const ids = Object.keys(weights).sort(compareIds)
  if (!isCents(total) || ids.length === 0 || !ids.every(id => isCents(weights[id]))) {
    throw new Error('Invalid proportional allocation')
  }
  const weightTotal = ids.reduce((sum, id) => sum + BigInt(weights[id]), 0n)
  if (weightTotal === 0n) return allocateEqual(total, ids)
  const exact = ids.map(id => {
    const product = BigInt(total) * BigInt(weights[id])
    return { id, share: product / weightTotal, rem: product % weightTotal }
  })
  const result = Object.fromEntries(exact.map(({ id, share }) => [id, Number(share)]))
  let remainder = total - Object.values(result).reduce((sum, value) => sum + value, 0)
  exact.sort((a, b) => (a.rem === b.rem ? compareIds(a.id, b.id) : a.rem > b.rem ? -1 : 1))
  for (const { id } of exact) if (remainder-- > 0) result[id] += 1
  return result
}

/**
 * What each person owes for an itemized expense with bill-level adjustments
 * (voucher, SST, service charge, rounding): the amount paid split in proportion to
 * each person's item subtotal, shared items included. Display only; the server
 * (expense_owed_shares) is authoritative and uses the same rule.
 */
export function owedShares(totalCents: number, perPersonItemCents: AllocationMap): AllocationMap {
  return allocateProportionally(totalCents, perPersonItemCents)
}

/**
 * Claim by unit: an item of `quantity` units costing `total` cents, where each id had `units[id]` units.
 * Every unit claimed: allocateProportionally(total, units) (667/333 for 3 x 10.00 over 2/1). Units still
 * unclaimed: each id gets floor(total * units / quantity) and the rest stays unallocated. Same rule as the
 * server's unit_shares.
 */
export function allocateByUnits(total: number, quantity: number, units: AllocationMap): AllocationMap {
  const counts = Object.values(units)
  const claimed = counts.reduce((sum, n) => sum + n, 0)
  if (!isCents(total) || !Number.isSafeInteger(quantity) || quantity < 1 || counts.some(n => !Number.isSafeInteger(n) || n < 1) || claimed > quantity) {
    throw new Error('Invalid unit allocation')
  }
  if (counts.length === 0) return {}
  if (claimed === quantity) return allocateProportionally(total, units)
  return Object.fromEntries(Object.entries(units).map(([id, n]) => [id, Number((BigInt(total) * BigInt(n)) / BigInt(quantity))]))
}

/**
 * One item's shares: quantity 1 -> allocateEqual among `ids`; quantity > 1 -> allocateByUnits, where an id without
 * a count in `units` had one unit.
 */
export function itemShares(item: { totalCents: number; quantity: number }, ids: string[], units: AllocationMap = {}): AllocationMap {
  if (ids.length === 0) return {}
  if (item.quantity <= 1) return allocateEqual(item.totalCents, ids)
  return allocateByUnits(item.totalCents, item.quantity, Object.fromEntries(ids.map(id => [id, units[id] ?? 1])))
}
