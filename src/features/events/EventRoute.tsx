import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { formatMoney } from '../../domain/money'
import { EventHomePage } from './EventHomePage'
import { EventStatus } from './EventStatus'
import { InvitePanel } from './InvitePanel'
import { useEventHome } from './useEventHome'

export function EventRoute() {
  const { eventId = '' } = useParams()
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [showInvite, setShowInvite] = useState(false)
  const state = useEventHome(eventId)
  if (state.status !== 'ready') return <EventStatus state={state} />
  const { home } = state
  const attention = home.attention.map(item => ({
    id: item.expenseId,
    label: t('event.unclaimed', { description: item.description, amount: formatMoney(item.unallocatedCents, home.event.currency, i18n.language) }),
    onSelect: () => navigate(`/event/${eventId}/expenses/${item.expenseId}/claim`),
  }))
  const settled = home.event.state === 'settled'
  const canSettle = !settled && home.me.role !== 'participant' && home.expenses.length > 0
  return (
    <EventHomePage
      eventName={home.event.name}
      currency={home.event.currency}
      expenses={home.expenses}
      attention={attention}
      onScanReceipt={() => navigate(`/event/${eventId}/expenses/new?scan=1`)}
      onAddExpense={() => navigate(`/event/${eventId}/expenses/new`)}
      onInvite={() => setShowInvite(shown => !shown)}
      settled={settled}
      onSettle={canSettle ? () => navigate(`/event/${eventId}/settle`) : undefined}
      onViewPayments={() => navigate(`/event/${eventId}/payments`)}
    >
      {showInvite && <InvitePanel eventId={eventId} />}
    </EventHomePage>
  )
}
