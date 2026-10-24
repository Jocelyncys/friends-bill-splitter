import type { AllocationMap } from './types'

function sortedIds(values: AllocationMap): string[] {
  return Object.keys(values).sort((a, b) => a.localeCompare(b))
}

export function allocateEqual(total: number, participantIds: string[]): AllocationMap {
  if (!Number.isSafeInteger(total) || total < 0 || participantIds.length === 0) throw new Error('Invalid equal allocation')
  const ids = [...participantIds].sort((a, b) => a.localeCompare(b))
  const base = Math.floor(total / ids.length)
  let remainder = total - base * ids.length
  return Object.fromEntries(ids.map(id => [id, base + (remainder-- > 0 ? 1 : 0)]))
}

export function validateCustomAllocation(total: number, values: AllocationMap) {
  const allocated = Object.values(values).reduce((sum, value) => sum + value, 0)
  const nonNegativeIntegers = Object.values(values).every(value => Number.isSafeInteger(value) && value >= 0)
  return { valid: nonNegativeIntegers && allocated === total, difference: total - allocated }
}

export function allocateProportionally(total: number, weights: AllocationMap): AllocationMap {
  const ids = sortedIds(weights)
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0)
  if (weightTotal <= 0) return allocateEqual(total, ids)
  const exact = ids.map(id => ({ id, raw: (total * weights[id]) / weightTotal }))
  const result = Object.fromEntries(exact.map(({ id, raw }) => [id, Math.floor(raw)]))
  let remainder = total - Object.values(result).reduce((sum, value) => sum + value, 0)
  exact.sort((a, b) => (b.raw % 1) - (a.raw % 1) || a.id.localeCompare(b.id))
  for (const { id } of exact) if (remainder-- > 0) result[id] += 1
  return result
}
