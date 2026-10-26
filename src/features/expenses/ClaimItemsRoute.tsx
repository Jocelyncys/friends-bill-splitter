import { useEffect, useState, useSyncExternalStore } from 'react'
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
  const [errorCode, setErrorCode] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    createClaimRepository()
      .getExpenseClaims(expenseId)
      .then(
        claims => {
          if (cancelled) return
          setLoaded({ expenseId, claims })
          setLoadFailedFor(null)
        },
        // Keep showing the last good data; the page shows a banner instead.
        () => !cancelled && setLoadFailedFor(expenseId),
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
    setErrorCode(null)
    try {
      await action()
      return true
    } catch (error) {
      setErrorCode(error instanceof ActionError ? error.code : 'action_failed')
      return false
    } finally {
      setBusy(false)
      setLocalTick(tick => tick + 1)
      shell?.refresh()
    }
  }
  const repository = createClaimRepository()

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
      errorMessage={errorCode ? t(`actionError.${errorCode}`, { defaultValue: t('actionError.action_failed') }) : loadFailedFor === expenseId ? t('event.loadFailed') : undefined}
      onClaim={itemId => void run(() => repository.claimItem(itemId))}
      onUnclaim={itemId => void run(() => repository.unclaimItem(itemId))}
      adjustmentCents={claims.adjustments.reduce((sum, adj) => sum + adj.amountCents, 0)}
      totalCents={claims.totalCents}
      onAssign={(itemId, memberIds) => run(() => repository.assignItem(itemId, memberIds))}
      onToggleClosed={closed => void run(() => repository.setClaimingClosed(expenseId, closed))}
    />
  )
}
