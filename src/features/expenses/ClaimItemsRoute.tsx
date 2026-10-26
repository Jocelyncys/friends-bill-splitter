import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useOutletContext, useParams } from 'react-router-dom'
import type { ShellContext } from '../../components/shellContext'
import { displayNames } from '../events/memberNames'
import { EventStatus } from '../events/EventStatus'
import { useEventHome } from '../events/useEventHome'
import { ActionError, createClaimRepository, type ExpenseClaims } from './claimRepository'
import { ClaimItemsPage, type ClaimItemView } from './ClaimItemsPage'

type Loaded = { expenseId: string; claims: ExpenseClaims }

function subscribeOnline(callback: () => void) {
  window.addEventListener('online', callback)
  window.addEventListener('offline', callback)
  return () => {
    window.removeEventListener('online', callback)
    window.removeEventListener('offline', callback)
  }
}
const isOnline = () => navigator.onLine

export function ClaimItemsRoute() {
  const { eventId = '', expenseId = '' } = useParams()
  const { t } = useTranslation()
  const shell = useOutletContext<ShellContext | undefined>()
  const refreshKey = shell?.refreshKey ?? 0
  const state = useEventHome(eventId)
  const online = useSyncExternalStore(subscribeOnline, isOnline)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadFailedFor, setLoadFailedFor] = useState<string | null>(null)
  const [localTick, setLocalTick] = useState(0)
  const [busy, setBusy] = useState(false)
  // itemId: the chip save that failed, so another item's save does not hide it.
  const [error, setError] = useState<{ code: string; itemId?: string } | null>(null)
  // Only the latest claims read is applied (an older, slower one must not overwrite it).
  const reloadSeq = useRef(0)

  useEffect(() => {
    let cancelled = false
    const seq = ++reloadSeq.current
    createClaimRepository()
      .getExpenseClaims(expenseId)
      .then(
        claims => {
          if (cancelled || seq !== reloadSeq.current) return
          setLoaded({ expenseId, claims })
          setLoadFailedFor(null)
        },
        // Keep showing the last good data; the page shows a banner instead.
        () => !cancelled && seq === reloadSeq.current && setLoadFailedFor(expenseId),
      )
    return () => {
      cancelled = true
    }
  }, [expenseId, refreshKey, localTick])

  if (state.status !== 'ready') return <EventStatus state={state} />
  const current = loaded?.expenseId === expenseId ? loaded : null
  if (!current) return loadFailedFor === expenseId ? <p role="alert">{t('event.loadFailed')}</p> : <p role="status">{t('common.loading')}</p>

  const { home } = state
  const { claims } = current
  const labels = displayNames(home.members)
  const participants = home.members.map(m => ({ id: m.userId, name: labels.get(m.userId) ?? m.displayName }))
  const items: ClaimItemView[] = claims.items.map(item => {
    const rows = claims.allocations.filter(a => a.itemId === item.id)
    return {
      id: item.id,
      description: item.description,
      quantity: item.quantity,
      totalCents: item.totalCents,
      claims: rows.map(a => ({ userId: a.participantUserId, amountCents: a.amountCents })),
      assigned: rows.some(a => a.source !== 'self_claim'),
    }
  })

  // After any action (even a failed one) reload so the page shows the server's truth.
  // Resolves true when the action succeeded.
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      return true
    } catch (error) {
      setError({ code: error instanceof ActionError ? error.code : 'action_failed' })
      return false
    } finally {
      setBusy(false)
      setLocalTick(tick => tick + 1)
      shell?.refresh()
    }
  }
  const repository = createClaimRepository()
  // Chip taps save on their own (no global busy lock), and resolve only after the fresh claims are on screen, so
  // the chips never flash back to the old state.
  const assign = async (itemId: string, memberIds: string[]): Promise<boolean> => {
    setError(previous => (previous?.itemId === itemId ? null : previous))
    let ok = true
    try {
      await repository.assignItem(itemId, memberIds)
    } catch (failure) {
      ok = false
      setError({ code: failure instanceof ActionError ? failure.code : 'action_failed', itemId })
    }
    const seq = ++reloadSeq.current
    try {
      const fresh = await repository.getExpenseClaims(expenseId)
      if (seq === reloadSeq.current) {
        setLoaded({ expenseId, claims: fresh })
        setLoadFailedFor(null)
      }
    } catch {
      if (seq === reloadSeq.current) setLoadFailedFor(expenseId)
    }
    shell?.refresh()
    return ok
  }

  return (
    <ClaimItemsPage
      role={home.me.role}
      currentUserId={home.me.userId}
      participants={participants}
      items={items}
      splitMethod={claims.splitMethod}
      claimingClosed={claims.claimingClosed}
      canManage={home.me.role !== 'participant' || claims.creatorUserId === home.me.userId}
      currency={home.event.currency}
      offline={!online}
      busy={busy}
      settled={home.event.state === 'settled'}
      errorMessage={error ? t(`actionError.${error.code}`, { defaultValue: t('actionError.action_failed') }) : loadFailedFor === expenseId ? t('event.loadFailed') : undefined}
      onClaim={itemId => void run(() => repository.claimItem(itemId))}
      onUnclaim={itemId => void run(() => repository.unclaimItem(itemId))}
      adjustmentCents={claims.adjustments.reduce((sum, adj) => sum + adj.amountCents, 0)}
      totalCents={claims.totalCents}
      onAssign={assign}
      onToggleClosed={closed => void run(() => repository.setClaimingClosed(expenseId, closed))}
    />
  )
}
