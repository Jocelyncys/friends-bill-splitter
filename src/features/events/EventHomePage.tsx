import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatMoney } from '../../domain/money'

type ExpenseSummary = { id: string; description: string; totalCents: number }
export type AttentionEntry = string | { label: string; onSelect: () => void }
type Props = {
  eventName: string
  expenses: ExpenseSummary[]
  attention: AttentionEntry[]
  currency?: string
  onScanReceipt?: () => void
  onAddExpense?: () => void
  onInvite?: () => void
  children?: ReactNode
}

export function EventHomePage({ eventName, expenses, attention, currency = 'MYR', onScanReceipt, onAddExpense, onInvite, children }: Props) {
  const { t, i18n } = useTranslation()
  const empty = expenses.length === 0
  return (
    <main>
      <p className="event-name">{eventName}</p>
      <h1>{empty ? t('event.emptyTitle') : t('event.activeTitle')}</h1>
      <section className={empty ? 'guided-actions guided-actions--large' : 'guided-actions'}>
        <button type="button" onClick={onScanReceipt} disabled={!onScanReceipt}>📷 {t('event.scanReceipt')}</button>
        <button type="button" onClick={onAddExpense} disabled={!onAddExpense}>✏️ {t('event.addSimple')}</button>
        <button type="button" onClick={onInvite} disabled={!onInvite}>🔗 {t('event.invite')}</button>
      </section>
      {children}
      {attention.length > 0 && (
        <section className="attention">
          <h2>{t('event.needsAttention')}</h2>
          <ul>
            {attention.map(item => {
              const label = typeof item === 'string' ? item : item.label
              return (
                <li key={label}>
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
