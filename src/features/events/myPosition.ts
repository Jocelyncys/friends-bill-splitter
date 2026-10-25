import { calculateBalances, settleOptimizedDirect, type Total, type Transfer } from '../../domain/settlement'

export type Counterpart = { userId: string; amountCents: number }
/** What the current user still owes and gets back. Both empty = all square. */
export type MyPosition = { owe: Counterpart[]; receive: Counterpart[] }

type TransferLike = Pick<Transfer, 'payerId' | 'receiverId' | 'amountCents'>

export function positionFrom(transfers: TransferLike[], myId: string): MyPosition {
  return {
    owe: transfers.filter(x => x.payerId === myId).map(x => ({ userId: x.receiverId, amountCents: x.amountCents })),
    receive: transfers.filter(x => x.receiverId === myId).map(x => ({ userId: x.payerId, amountCents: x.amountCents })),
  }
}

/**
 * Preview of the current user's position before settlement, using the optimized direct plan (the
 * recommended method). 'waiting' while an itemized expense still has unassigned items.
 */
export function estimatePosition(inputs: { totals: Total[]; unresolved: unknown[] }, myId: string): MyPosition | 'waiting' {
  if (inputs.unresolved.length > 0) return 'waiting'
  if (inputs.totals.length === 0) return { owe: [], receive: [] }
  return positionFrom(settleOptimizedDirect(calculateBalances(inputs.totals)), myId)
}
