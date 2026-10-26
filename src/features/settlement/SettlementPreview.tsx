import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { AlertIcon } from '../../components/icons'
import { formatMoney } from '../../domain/money'
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
  /** Settles with the fewest direct payments (optimized_direct), the only method offered. */
  onSettleNow?: () => void
}

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
  const [confirming, setConfirming] = useState<{ revision?: number } | null>(null)
  const [staleNotice, setStaleNotice] = useState(false)
  const money = (cents: number) => formatMoney(cents, currency, i18n.language)

  const nameOf = (id: string) => preview?.members.find(m => m.id === id)?.name ?? t('settlement.formerMember')
  const transfers = preview?.transfers ?? []
  const blocked = !preview || unresolved.length > 0 || Boolean(settleBlockedMessage) || busy

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
        <section className="plan" aria-labelledby="plan-transfers-title">
          <div className="plan__totals">
            <p>{t('settlement.totalPaid', { amount: money(preview.totalPaidCents) })}</p>
            <p>{t('settlement.totalOwed', { amount: money(preview.totalOwedCents) })}</p>
          </div>
          <ul className="plain-list plan__balances">
            {preview.members.map(m => (
              <li key={m.id}>{balanceText(m.id)}</li>
            ))}
          </ul>
          <div className="receipt">
            <div className="receipt__paper">
              <h2 id="plan-transfers-title" className="receipt__title">{t('settlement.transfersTitle')}</h2>
              <ul className="plain-list" aria-labelledby="plan-transfers-title">
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
        </section>
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
            onSettleNow?.()
          }}
        >
          <p>{t('settlement.transferCount', { count: transfers.length })}</p>
          <p>{t('settlement.confirmReadOnly')}</p>
        </ConfirmDialog>
      )}
    </main>
  )
}
