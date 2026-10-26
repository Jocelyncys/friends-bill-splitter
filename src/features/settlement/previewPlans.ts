import { calculateBalances, settleOptimizedDirect, type Total, type Transfer } from '../../domain/settlement'
import { displayNames } from '../events/memberNames'

export type PreviewMember = { id: string; name: string }

export type PreviewData = {
  members: PreviewMember[]
  balances: Record<string, number> // positive = receives, negative = pays (integer cents)
  totalPaidCents: number
  totalOwedCents: number
  /** The fewest direct payments (optimized_direct), the only method offered. */
  transfers: Transfer[]
}

/** The settlement preview computed client-side (the server recomputes on confirm). */
export function buildPreview(members: Array<{ userId: string; displayName: string }>, totals: Total[]): PreviewData {
  const labels = displayNames(members)
  const balances = calculateBalances(totals)
  return {
    members: members.map(m => ({ id: m.userId, name: labels.get(m.userId) ?? m.displayName })),
    balances,
    totalPaidCents: totals.reduce((sum, x) => sum + x.paidCents, 0),
    totalOwedCents: totals.reduce((sum, x) => sum + x.owedCents, 0),
    transfers: settleOptimizedDirect(balances),
  }
}
