import { compareIds } from '../../domain/allocation'
import {
  calculateBalances,
  settleOptimizedDirect,
  settleOriginalPayers,
  settleViaCoordinator,
  type PayerAllocation,
  type Total,
  type Transfer,
} from '../../domain/settlement'
import { displayNames } from '../events/memberNames'

export type PreviewMember = { id: string; name: string }

export type PreviewData = {
  members: PreviewMember[]
  balances: Record<string, number> // positive = receives, negative = pays (integer cents)
  totalPaidCents: number
  totalOwedCents: number
  plans: {
    original: Transfer[]
    optimized: Transfer[]
    coordinator: Record<string, Transfer[]> // by coordinator id; only net creditors
  }
}

/** The three settlement methods computed client-side (the server recomputes on confirm). */
export function buildPreview(
  members: Array<{ userId: string; displayName: string }>,
  totals: Total[],
  payerAllocations: PayerAllocation[],
): PreviewData {
  const labels = displayNames(members)
  const balances = calculateBalances(totals)
  const coordinator: Record<string, Transfer[]> = {}
  for (const id of Object.keys(balances).sort(compareIds)) {
    if (balances[id] > 0) coordinator[id] = settleViaCoordinator(balances, id)
  }
  return {
    members: members.map(m => ({ id: m.userId, name: labels.get(m.userId) ?? m.displayName })),
    balances,
    totalPaidCents: totals.reduce((sum, x) => sum + x.paidCents, 0),
    totalOwedCents: totals.reduce((sum, x) => sum + x.owedCents, 0),
    plans: {
      original: settleOriginalPayers(payerAllocations),
      optimized: settleOptimizedDirect(balances),
      coordinator,
    },
  }
}
