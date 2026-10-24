import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useParams } from 'react-router-dom'
import { formatMoney } from '../../domain/money'
import { EventStatus } from '../events/EventStatus'
import { useEventHome } from '../events/useEventHome'
import { createExpenseRepository, type ExpenseSummary } from './expenseRepository'

type Loaded = { eventId: string; expenses: ExpenseSummary[] } | { eventId: string; failed: true }

export function ExpenseListPage() {
  const { eventId = '' } = useParams()
  const { t, i18n } = useTranslation()
  const state = useEventHome(eventId)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let cancelled = false
    createExpenseRepository()
      .listExpenses(eventId)
      .then(
        expenses => !cancelled && setLoaded({ eventId, expenses }),
        () => !cancelled && setLoaded({ eventId, failed: true }),
      )
    return () => {
      cancelled = true
    }
  }, [eventId])

  if (state.status !== 'ready') return <EventStatus state={state} />
  const { home } = state
  const current = loaded?.eventId === eventId ? loaded : null
  const names = new Map(home.members.map(m => [m.userId, m.displayName]))
  const expenses = current && 'expenses' in current ? [...current.expenses].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []

  return (
    <main>
      <h1>{t('expenses.title')}</h1>
      <Link className="button primary" to={`/event/${eventId}/expenses/new`}>{t('expenses.add')}</Link>
      {!current && <p role="status">{t('common.loading')}</p>}
      {current && 'failed' in current && <p role="alert">{t('event.loadFailed')}</p>}
      {current && 'expenses' in current && expenses.length === 0 && <p>{t('expenses.empty')}</p>}
      {expenses.map(expense => (
        <article key={expense.id} className="expense-row">
          <div>
            <span>{expense.description}</span>
            <small>{t('expenses.paidBy', { name: names.get(expense.payerUserId) ?? '?' })}</small>
          </div>
          <strong>{formatMoney(expense.totalCents, home.event.currency, i18n.language)}</strong>
        </article>
      ))}
    </main>
  )
}
