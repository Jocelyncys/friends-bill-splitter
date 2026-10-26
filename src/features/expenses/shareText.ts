import type { TFunction } from 'i18next'
import { owedShares } from '../../domain/allocation'

/**
 * "Shared by 3, RM 4.00 each". With extra cents (allocateEqual gives them to some people) the amount is a
 * range: "Shared by 2, RM 0.02 to RM 0.03 each".
 */
export function sharedEachText(t: TFunction, money: (cents: number) => string, totalCents: number, count: number): string {
  const low = Math.floor(totalCents / count)
  const high = low + (totalCents % count === 0 ? 0 : 1)
  const amount = low === high ? money(low) : t('claim.amountRange', { min: money(low), max: money(high) })
  return t('claim.sharedEach', { count, amount })
}

/** "−RM 3.57" / "+RM 1.20": the discounts, tax and rounding of a bill, with a real minus sign. */
export const signedMoney = (money: (cents: number) => string, cents: number) => `${cents < 0 ? '−' : '+'}${money(Math.abs(cents))}`

export type PaysRow = { userId: string; name: string; itemsCents: number; paysCents: number }

/** What each person pays: the amount paid split over their items subtotals (domain owedShares, live display). */
export function paysRows(paidCents: number, itemCents: Record<string, number>, people: Array<{ id: string; name: string }>): PaysRow[] {
  if (!Number.isSafeInteger(paidCents) || paidCents < 0 || Object.keys(itemCents).length === 0) return []
  const owed = owedShares(paidCents, itemCents)
  return people
    .filter(p => p.id in itemCents)
    .map(p => ({ userId: p.id, name: p.name, itemsCents: itemCents[p.id], paysCents: owed[p.id] }))
}
