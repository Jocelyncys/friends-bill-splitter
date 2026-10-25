import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { ShellContext } from '../../components/shellContext'
import { createSettlementRepository } from '../settlement/settlementRepository'
import type { EventHome } from './eventRepository'
import { estimatePosition, positionFrom, type MyPosition } from './myPosition'

export type PositionView = { position: MyPosition | 'waiting'; estimate: boolean }

/**
 * The current user's "who owes whom" line for the event home: an estimate from the settlement inputs
 * while the event is open, the outstanding confirmed transfers once it is settled. null while loading
 * or when it could not be loaded (the home page simply leaves it out).
 */
export function useMyPosition(home: EventHome | undefined): PositionView | null {
  const refreshKey = useOutletContext<ShellContext | undefined>()?.refreshKey ?? 0
  const [loaded, setLoaded] = useState<{ key: string; view: PositionView | null } | null>(null)
  const eventId = home?.event.id
  const myId = home?.me.userId
  const settled = home?.event.state === 'settled'
  const key = `${eventId}:${home?.event.revision}:${settled}`

  useEffect(() => {
    if (!eventId || !myId) return
    let cancelled = false
    const repository = createSettlementRepository()
    const load: Promise<PositionView | null> = settled
      ? repository.getSettlement(eventId).then(settlement =>
          settlement
            ? { position: positionFrom(settlement.transfers.filter(x => x.state !== 'confirmed'), myId), estimate: false }
            : null,
        )
      : repository.getSettlementInputs(eventId).then(inputs => ({ position: estimatePosition(inputs, myId), estimate: true }))
    load.then(
      view => !cancelled && setLoaded({ key, view }),
      () => !cancelled && setLoaded({ key, view: null }),
    )
    return () => {
      cancelled = true
    }
  }, [eventId, myId, settled, key, refreshKey])

  return loaded?.key === key ? loaded.view : null
}
