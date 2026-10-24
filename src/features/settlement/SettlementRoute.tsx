import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useOutletContext, useParams } from 'react-router-dom'
import type { ShellContext } from '../../components/shellContext'
import { useOnline } from '../../lib/useOnline'
import { EventStatus } from '../events/EventStatus'
import { displayNames } from '../events/memberNames'
import { useEventHome } from '../events/useEventHome'
import { PaymentDetailsForm } from '../payments/PaymentDetailsForm'
import { createPaymentRepository } from '../payments/paymentRepository'
import { buildPreview, type PreviewData } from './previewPlans'
import { SettlementPage } from './SettlementPage'
import { createSettlementRepository, SettlementError, type Settlement, type SettlementInputs, type SettlementMethod } from './settlementRepository'

type Loaded<T> = { eventId: string; value: T }

const errorKey = (error: unknown) => `settlementError.${error instanceof SettlementError ? error.code : 'action_failed'}`

export function SettlementRoute({ phase }: { phase: 'preview' | 'payment' }) {
  const { eventId = '' } = useParams()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const shell = useOutletContext<ShellContext | undefined>()
  const refreshKey = shell?.refreshKey ?? 0
  const online = useOnline()
  const state = useEventHome(eventId)
  const [inputs, setInputs] = useState<Loaded<SettlementInputs> | null>(null)
  const [settlement, setSettlement] = useState<Loaded<Settlement | null> | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [localTick, setLocalTick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | undefined>()
  const [missing, setMissing] = useState<{ settlementId: string; ids: string[] } | null>(null)
  const myId = state.status === 'ready' ? state.home.me.userId : undefined

  useEffect(() => {
    let cancelled = false
    const repository = createSettlementRepository()
    const done = () => !cancelled && setLoadFailed(false)
    const failed = () => !cancelled && setLoadFailed(true) // keep the last good data on screen
    if (phase === 'preview') {
      repository.getSettlementInputs(eventId).then(value => {
        if (cancelled) return
        setInputs({ eventId, value })
        done()
      }, failed)
    } else {
      repository.getSettlement(eventId).then(value => {
        if (cancelled) return
        setSettlement({ eventId, value })
        done()
      }, failed)
    }
    return () => {
      cancelled = true
    }
  }, [phase, eventId, refreshKey, localTick])

  // Which of my transfers have a receiver without details yet. Only a yes/no is kept; the
  // details (and any signed QR URL) are discarded straight away.
  const loadedSettlement = settlement?.eventId === eventId ? settlement.value : null
  useEffect(() => {
    if (phase !== 'payment' || !loadedSettlement || !myId) return
    let cancelled = false
    const mine = loadedSettlement.transfers.filter(x => x.payerId === myId && x.state === 'pending')
    const repo = createPaymentRepository()
    void Promise.all(mine.map(x => repo.getReceiverDetails(x.id).then(d => (d ? null : x.id), () => null))).then(results => {
      if (!cancelled) setMissing({ settlementId: loadedSettlement.id, ids: results.filter((id): id is string => id !== null) })
    })
    return () => {
      cancelled = true
    }
  }, [phase, loadedSettlement, myId])

  if (state.status !== 'ready') return <EventStatus state={state} />
  const { home } = state
  const isManager = home.me.role !== 'participant'
  const reload = () => {
    setLocalTick(tick => tick + 1)
    shell?.refresh()
  }

  if (phase === 'preview') {
    if (!isManager) return <p role="alert">{t('settlement.notAllowed')}</p>
    if (home.event.state === 'settled') return <Navigate to={`/event/${eventId}/payments`} replace />
    const current = inputs?.eventId === eventId ? inputs.value : null
    if (!current) return loadFailed ? <p role="alert">{t('event.loadFailed')}</p> : <p role="status">{t('common.loading')}</p>

    let preview: PreviewData | undefined
    let previewFailed = false
    if (current.unresolved.length === 0 && current.totals.length > 0) {
      try {
        preview = buildPreview(current.members, current.totals, current.payerAllocations)
      } catch {
        preview = undefined
        previewFailed = true
      }
    }
    const blockedMessage = !online
      ? t('settlement.offline')
      : shell && shell.realtimeStatus !== 'live'
        ? t('settlement.notLive')
        : current.totals.length === 0
          ? t('settlement.noExpenses')
          : undefined

    const settle = async (method: SettlementMethod, coordinatorId: string | null) => {
      setBusy(true)
      setErrorMessage(undefined)
      try {
        await createSettlementRepository().confirmSettlement({ eventId, method, coordinatorId, expectedRevision: current.revision })
        shell?.refresh()
        navigate(`/event/${eventId}/payments`)
      } catch (error) {
        setErrorMessage(t(errorKey(error)))
        reload() // show the server's current truth (an updated preview after stale_revision)
      } finally {
        setBusy(false)
      }
    }

    return (
      <SettlementPage
        phase="preview"
        transfers={[]}
        preview={preview}
        currency={home.event.currency}
        unresolved={current.unresolved}
        eventId={eventId}
        revision={current.revision}
        settleBlockedMessage={blockedMessage}
        busy={busy}
        errorMessage={errorMessage ?? (previewFailed ? t('settlement.previewFailed') : loadFailed ? t('event.loadFailed') : undefined)}
        onCancel={() => navigate(`/event/${eventId}`)}
        onLater={() => navigate(`/event/${eventId}`)}
        onSettleNow={(method, coordinatorId) => void settle(method, coordinatorId)}
      />
    )
  }

  const current = settlement?.eventId === eventId ? settlement.value : undefined
  if (settlement?.eventId !== eventId) return loadFailed ? <p role="alert">{t('event.loadFailed')}</p> : <p role="status">{t('common.loading')}</p>
  if (!current) return <p role="status">{t('payments.notSettled')}</p>

  const labels = displayNames(home.members)
  const names = Object.fromEntries(home.members.map(m => [m.userId, labels.get(m.userId) ?? m.displayName]))
  const payments = createPaymentRepository()
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true)
    setErrorMessage(undefined)
    try {
      await action()
      return true
    } catch (error) {
      setErrorMessage(t(errorKey(error)))
      return false
    } finally {
      setBusy(false)
      reload()
    }
  }

  return (
    <SettlementPage
      phase="payment"
      transfers={current.transfers}
      currentUserId={home.me.userId}
      role={home.me.role}
      names={names}
      currency={home.event.currency}
      busy={busy}
      errorMessage={errorMessage ?? (loadFailed ? t('event.loadFailed') : undefined)}
      detailsForm={
        <PaymentDetailsForm
          eventId={eventId}
          userId={home.me.userId}
          warnBeforeSave={current.transfers.some(x => x.receiverId === home.me.userId && x.state === 'sent')}
        />
      }
      onShowDetails={transferId => payments.getReceiverDetails(transferId)}
      onMarkSent={transferId => void run(() => payments.markSent(transferId))}
      onConfirmReceived={transferId => void run(() => payments.confirmReceived(transferId))}
      missingDetailsFor={missing?.settlementId === current.id ? missing.ids : []}
      onOverride={(transferId, reason) => run(() => payments.override(transferId, reason))}
    />
  )
}
