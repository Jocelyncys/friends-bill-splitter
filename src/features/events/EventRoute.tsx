import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { formatMoney } from '../../domain/money'
import { DraftList } from '../offline/DraftList'
import { useDrafts } from '../offline/useDrafts'
import { EventHomePage } from './EventHomePage'
import { EventStatus } from './EventStatus'
import { InvitePanel } from './InvitePanel'
import { displayNames } from './memberNames'
import { useMyPosition } from './useMyPosition'
import { useEventHome } from './useEventHome'

export function EventRoute() {
  const { eventId = '' } = useParams()
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  // Set only when the new event's invite token could not be stored on this device: show it once.
  const unsavedInviteToken = (useLocation().state as { unsavedInviteToken?: string } | null)?.unsavedInviteToken
  const [showInvite, setShowInvite] = useState(!!unsavedInviteToken)
  const state = useEventHome(eventId)
  const { drafts, loaded: draftsLoaded } = useDrafts(eventId)
  const position = useMyPosition(state.status === 'ready' ? state.home : undefined)
  if (state.status !== 'ready') return <EventStatus state={state} />
  const { home } = state
  const attention = home.attention.map(item => ({
    id: item.expenseId,
    label: t('event.unclaimed', { description: item.description, amount: formatMoney(item.unallocatedCents, home.event.currency, i18n.language) }),
    onSelect: () => navigate(`/event/${eventId}/expenses/${item.expenseId}/claim`),
  }))
  const settled = home.event.state === 'settled'
  const labels = displayNames(home.members)
  const names = Object.fromEntries(home.members.map(m => [m.userId, labels.get(m.userId) ?? m.displayName]))
  const canSettle = !settled && home.me.role !== 'participant' && home.expenses.length > 0
  return (
    <EventHomePage
      eventName={home.event.name}
      currency={home.event.currency}
      expenses={home.expenses}
      attention={attention}
      groupTotalCents={home.groupTotalCents}
      position={position}
      names={names}
      onViewAll={() => navigate(`/event/${eventId}/expenses`)}
      onScanReceipt={() => navigate(`/event/${eventId}/expenses/new?scan=1`)}
      onAddExpense={() => navigate(`/event/${eventId}/expenses/new`)}
      onInvite={() => setShowInvite(shown => !shown)}
      settled={settled}
      onSettle={canSettle ? () => navigate(`/event/${eventId}/settle`) : undefined}
      settleBlockedReason={!draftsLoaded ? t('drafts.checking') : drafts.length > 0 ? t('drafts.settleBlocked') : undefined}
      onViewPayments={() => navigate(`/event/${eventId}/payments`)}
    >
      <DraftList eventId={eventId} currency={home.event.currency} />
      {showInvite && <InvitePanel eventId={eventId} token={unsavedInviteToken} />}
    </EventHomePage>
  )
}
