import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatMoney } from '../../domain/money'

type ExpenseSummary = { id: string; description: string; totalCents: number }
export type AttentionEntry = string | { id: string; label: string; onSelect: () => void }
type Props = {
  eventName: string
  expenses: ExpenseSummary[]
  attention: AttentionEntry[]
  currency?: string
  onScanReceipt?: () => void
  onAddExpense?: () => void
  onInvite?: () => void
  /** Owner/co-host with expenses on an open event. */
  onSettle?: () => void
  /** Event is settled: expenses are read-only and payments take over. */
  settled?: boolean
  onViewPayments?: () => void
  children?: ReactNode
}

export function EventHomePage({ eventName, expenses, attention, currency = 'MYR', onScanReceipt, onAddExpense, onInvite, onSettle, settled = false, onViewPayments, children }: Props) {
  const { t, i18n } = useTranslation()
  const empty = expenses.length === 0
  return (
    <main>
      <p className="event-name">{eventName}</p>
      <h1>{empty ? t('event.emptyTitle') : t('event.activeTitle')}</h1>
      <section className={empty ? 'guided-actions guided-actions--large' : 'guided-actions'}>
        {!settled && <button type="button" onClick={onScanReceipt} disabled={!onScanReceipt}><span aria-hidden="true">📷</span> {t('event.scanReceipt')}</button>}
        {!settled && <button type="button" onClick={onAddExpense} disabled={!onAddExpense}><span aria-hidden="true">✏️</span> {t('event.addSimple')}</button>}
        <button type="button" onClick={onInvite} disabled={!onInvite}><span aria-hidden="true">🔗</span> {t('event.invite')}</button>
        {!settled && onSettle && <button type="button" className="primary" onClick={onSettle}><span aria-hidden="true">💸</span> {t('event.settleNow')}</button>}
        {settled && <button type="button" className="primary" onClick={onViewPayments} disabled={!onViewPayments}><span aria-hidden="true">💸</span> {t('event.viewPayments')}</button>}
      </section>
      {settled && <p className="muted">{t('event.settledNote')}</p>}
      {children}
      {attention.length > 0 && (
        <section className="attention">
          <h2>{t('event.needsAttention')}</h2>
          <ul>
            {attention.map(item => {
              const label = typeof item === 'string' ? item : item.label
              const key = typeof item === 'string' ? item : item.id
              return (
                <li key={key}>
                  {typeof item === 'string' ? label : <button type="button" onClick={item.onSelect}>{label}</button>}
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {!empty && (
        <section>
          <h2>{t('event.latestExpenses')}</h2>
          {expenses.slice(0, 3).map(item => (
            <article key={item.id} className="expense-row">
              <span>{item.description}</span>
              <strong>{formatMoney(item.totalCents, currency, i18n.language)}</strong>
            </article>
          ))}
        </section>
      )}
    </main>
  )
}
