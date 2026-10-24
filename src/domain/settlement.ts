import { compareIds } from './allocation'

export type Total = { userId: string; paidCents: number; owedCents: number }
export type Transfer = { payerId: string; receiverId: string; amountCents: number }
export type PayerAllocation = { expenseId: string; payerId: string; participantId: string; amountCents: number }

function assertCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be non-negative integer cents`)
}

function assertBalances(balances: Record<string, number>): void {
  let sum = 0
  for (const value of Object.values(balances)) {
    if (!Number.isSafeInteger(value)) throw new Error('Balances must be integer cents')
    sum += value
  }
  if (sum !== 0) throw new Error('Balances must sum to zero')
}

export function calculateBalances(totals: Total[]): Record<string, number> {
  const balances: Record<string, number> = {}
  for (const { userId, paidCents, owedCents } of totals) {
    if (Object.hasOwn(balances, userId)) throw new Error(`Duplicate userId: ${userId}`)
    assertCents(paidCents, 'paidCents')
    assertCents(owedCents, 'owedCents')
    balances[userId] = paidCents - owedCents
  }
  assertBalances(balances)
  return balances
}

type Side = { id: string; amount: number }

function sides(balances: Record<string, number>, sign: 1 | -1): Side[] {
  return Object.entries(balances)
    .filter(([, value]) => value * sign > 0)
    .map(([id, value]) => ({ id, amount: value * sign }))
    .sort((a, b) => b.amount - a.amount || compareIds(a.id, b.id))
}

/** Greedy matching: largest debtor pays largest creditor first, ties by ascending id. */
export function settleOptimizedDirect(balances: Record<string, number>): Transfer[] {
  assertBalances(balances)
  const debtors = sides(balances, -1)
  const creditors = sides(balances, 1)
  const transfers: Transfer[] = []
  let d = 0
  let c = 0
  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(debtors[d].amount, creditors[c].amount)
    transfers.push({ payerId: debtors[d].id, receiverId: creditors[c].id, amountCents: amount })
    debtors[d].amount -= amount
    creditors[c].amount -= amount
    if (debtors[d].amount === 0) d += 1
    if (creditors[c].amount === 0) c += 1
  }
  return transfers
}

/** Every debtor pays the coordinator, who then pays every other creditor. */
export function settleViaCoordinator(balances: Record<string, number>, coordinatorId: string): Transfer[] {
  assertBalances(balances)
  if (!Object.hasOwn(balances, coordinatorId) || balances[coordinatorId] <= 0) {
    throw new Error('Coordinator must be a net creditor')
  }
  const ids = Object.keys(balances).sort(compareIds)
  const transfers: Transfer[] = []
  for (const id of ids) {
    if (balances[id] < 0) transfers.push({ payerId: id, receiverId: coordinatorId, amountCents: -balances[id] })
  }
  for (const id of ids) {
    if (id !== coordinatorId && balances[id] > 0) {
      transfers.push({ payerId: coordinatorId, receiverId: id, amountCents: balances[id] })
    }
  }
  return transfers
}

/**
 * Each participant pays the original payer of each expense they share in.
 * Amounts are summed per (participant, payer) pair and never netted against
 * the opposite pair, so every transfer stays traceable to its expenses.
 */
export function settleOriginalPayers(rows: PayerAllocation[]): Transfer[] {
  const owed = new Map<string, Transfer>()
  for (const { payerId, participantId, amountCents } of rows) {
    assertCents(amountCents, 'Allocation amountCents')
    if (participantId === payerId || amountCents === 0) continue
    const key = `${participantId}\u0000${payerId}`
    const entry = owed.get(key) ?? { payerId: participantId, receiverId: payerId, amountCents: 0 }
    entry.amountCents += amountCents
    owed.set(key, entry)
  }
  return [...owed.values()].sort((a, b) => compareIds(a.payerId, b.payerId) || compareIds(a.receiverId, b.receiverId))
}
