import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { AlertIcon } from '../../components/icons'
import { compareIds } from '../../domain/allocation'
import { formatMoney } from '../../domain/money'
import type { Transfer } from '../../domain/settlement'
import type { SettlementMethod } from './settlementRepository'
import type { PreviewData } from './previewPlans'

export type SettlementPreviewProps = {
  preview?: PreviewData
  currency?: string
  unresolved?: Array<{ expenseId: string; description: string; unallocatedCents: number }>
  /** Event id, for links to each unresolved expense's claim page. */
  eventId?: string
  /** Revision the preview was read at; a change while the dialog is open cancels the confirmation. */
  revision?: number
  /** Why finalizing is currently blocked (offline, realtime down); shown and disables Settle now. */
  settleBlockedMessage?: string
  busy?: boolean
  errorMessage?: string
  onCancel?: () => void
  onLater?: () => void
  onSettleNow?: (method: SettlementMethod, coordinatorId: string | null) => void
}

type CardKey = 'original' | 'optimized' | 'coordinator'
const METHODS: Array<{ method: SettlementMethod; key: CardKey }> = [
  { method: 'original_payers', key: 'original' },
  { method: 'optimized_direct', key: 'optimized' },
  { method: 'coordinator', key: 'coordinator' },
]

export function SettlementPreview({
  preview,
  currency = 'MYR',
  unresolved = [],
  eventId = '',
  revision,
  settleBlockedMessage,
  busy = false,
  errorMessage,
  onCancel,
  onLater,
  onSettleNow,
}: SettlementPreviewProps) {
  const { t, i18n } = useTranslation()
  const [method, setMethod] = useState<SettlementMethod>('optimized_direct')
  const [pickedCoordinator, setPickedCoordinator] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<{ revision?: number } | null>(null)
  const [staleNotice, setStaleNotice] = useState(false)
  const money = (cents: number) => formatMoney(cents, currency, i18n.language)

  const nameOf = (id: string) => preview?.members.find(m => m.id === id)?.name ?? t('settlement.formerMember')
  const coordinators = preview
    ? preview.members
        .filter(m => (preview.balances[m.id] ?? 0) > 0)
        .sort((a, b) => preview.balances[b.id] - preview.balances[a.id] || a.name.localeCompare(b.name) || compareIds(a.id, b.id))
    : []
  const coordinatorId = coordinators.find(c => c.id === pickedCoordinator)?.id ?? coordinators[0]?.id ?? null

  const transfersFor = (key: CardKey): Transfer[] => {
    if (!preview) return []
    if (key === 'coordinator') return coordinatorId ? (preview.plans.coordinator[coordinatorId] ?? []) : []
    return preview.plans[key]
  }

  const chosenKey = METHODS.find(m => m.method === method)!.key
  const blocked = !preview || unresolved.length > 0 || Boolean(settleBlockedMessage) || busy || (method === 'coordinator' && !coordinatorId)

  // The confirmation is only valid for the exact state it was opened on: drop it as soon as
  // finalizing is blocked (offline, realtime lost, unresolved) or the revision moved.
  if (confirming && (blocked || confirming.revision !== revision)) {
    setConfirming(null)
    if (!blocked) setStaleNotice(true)
  }

  const balanceText = (id: string) => {
    const net = preview?.balances[id] ?? 0
    if (net > 0) return t('settlement.balance.receives', { name: nameOf(id), amount: money(net) })
    if (net < 0) return t('settlement.balance.pays', { name: nameOf(id), amount: money(-net) })
    return t('settlement.balance.even', { name: nameOf(id) })
  }

  return (
    <main className="settlement">
      <h1>{t('settlement.previewTitle')}</h1>
      <p className="lede">{t('settlement.previewHint')}</p>

      {unresolved.length > 0 && (
        <section className="attention" aria-labelledby="unresolved-title">
          <h2 id="unresolved-title"><AlertIcon />{t('settlement.unresolvedTitle')}</h2>
          <p>{t('settlement.unresolvedHint')}</p>
          <ul>
            {unresolved.map(item => (
              <li key={item.expenseId}>
                <Link to={`/event/${eventId}/expenses/${item.expenseId}/claim`}>
                  {t('event.unclaimed', { description: item.description, amount: money(item.unallocatedCents) })}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {preview && (
        <div role="radiogroup" aria-label={t('settlement.methodGroup')} className="plan-cards">
          {METHODS.map(({ method: value, key }) => {
            const transfers = transfersFor(key)
            const disabled = key === 'coordinator' && coordinators.length === 0
            return (
              <article key={value} className={method === value ? 'plan-card plan-card--selected' : 'plan-card'}>
                <label className="plan-card__title">
                  <input type="radio" name="method" value={value} checked={method === value} disabled={disabled} onChange={() => setMethod(value)} />
                  <strong>{t(`settlement.method.${key}`)}</strong>
                  {key === 'optimized' && <span className="badge">{t('settlement.recommended')}</span>}
                </label>
                <p className="muted">{t(`settlement.methodHint.${key}`)}</p>
                {key === 'coordinator' && coordinators.length > 0 && (
                  <label className="field">
                    <span>{t('settlement.coordinator')}</span>
                    <select
                      value={coordinatorId ?? ''}
                      onChange={event => {
                        setPickedCoordinator(event.target.value)
                        setMethod('coordinator')
                      }}
                    >
                      {coordinators.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                <div className="plan-card__totals">
                  <p>{t('settlement.totalPaid', { amount: money(preview.totalPaidCents) })}</p>
                  <p>{t('settlement.totalOwed', { amount: money(preview.totalOwedCents) })}</p>
                </div>
                <ul className="plain-list plan-card__balances">
                  {preview.members.map(m => (
                    <li key={m.id}>{balanceText(m.id)}</li>
                  ))}
                </ul>
                <div className="receipt">
                  <div className="receipt__paper">
                    <h3 className="receipt__title">{t('settlement.transfersTitle')}</h3>
                    <ul className="plain-list">
                      {transfers.map((x, index) => (
                        <li key={index} className="receipt__row">
                          <span>{t('settlement.transferRow', { payer: nameOf(x.payerId), receiver: nameOf(x.receiverId) })}</span>
                          <span className="amount">{money(x.amountCents)}</span>
                        </li>
                      ))}
                    </ul>
                    <hr className="receipt__rule" />
                    <p className="receipt__total">
                      <span>{t('settlement.transferCount', { count: transfers.length })}</span>
                    </p>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}

      <div aria-live="assertive" className="settlement__notice">{(errorMessage || staleNotice) && <p className="form-error">{errorMessage ?? t('settlementError.stale_revision')}</p>}</div>
      {settleBlockedMessage && <p role="status" className="muted">{settleBlockedMessage}</p>}

      <footer className="settlement__footer">
        <button type="button" className="primary" disabled={blocked} onClick={() => {
          setStaleNotice(false)
          setConfirming({ revision })
        }}>{t('settlement.settleNow')}</button>
        <button type="button" onClick={onLater}>{t('settlement.later')}</button>
        <button type="button" className="quiet" onClick={onCancel}>{t('settlement.cancel')}</button>
      </footer>

      {confirming && (
        <ConfirmDialog
          title={t('settlement.confirmTitle')}
          confirmLabel={t('settlement.confirm')}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null)
            onSettleNow?.(method, method === 'coordinator' ? coordinatorId : null)
          }}
        >
          <p>{t('settlement.confirmMethod', { method: t(`settlement.method.${chosenKey}`) })}</p>
          <p>{t('settlement.transferCount', { count: transfersFor(chosenKey).length })}</p>
          <p>{t('settlement.confirmReadOnly')}</p>
        </ConfirmDialog>
      )}
    </main>
  )
}
