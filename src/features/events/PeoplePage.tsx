import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOutletContext, useParams } from 'react-router-dom'
import type { ShellContext } from '../../components/shellContext'
import { ActionError } from '../expenses/claimRepository'
import { useOnline } from '../../lib/useOnline'
import { AddPersonForm } from './AddPersonForm'
import { createEventRepository } from './eventRepository'
import { EventStatus } from './EventStatus'
import { InvitePanel } from './InvitePanel'
import { displayNames } from './memberNames'
import { useEventHome } from './useEventHome'

export function PeoplePage() {
  const { eventId = '' } = useParams()
  const { t } = useTranslation()
  const shell = useOutletContext<ShellContext | undefined>()
  const state = useEventHome(eventId)
  const online = useOnline()
  const [busy, setBusy] = useState(false)
  const [errorCode, setErrorCode] = useState<string | null>(null)
  if (state.status !== 'ready') return <EventStatus state={state} />
  const { home } = state
  const labels = displayNames(home.members)
  const settled = home.event.state === 'settled'
  // Role changes are writes: none once the event is settled.
  const isOwner = home.me.role === 'owner' && !settled
  // Owners and co-hosts add (and remove) people who were not invited, while the event is open.
  const canAddPeople = home.me.role !== 'participant' && home.event.state === 'open'

  const changeRole = async (memberId: string, role: 'cohost' | 'participant') => {
    setBusy(true)
    setErrorCode(null)
    try {
      await createEventRepository().setMemberRole(eventId, memberId, role)
    } catch (error) {
      setErrorCode(error instanceof ActionError ? error.code : 'action_failed')
    } finally {
      setBusy(false)
      shell?.refresh()
    }
  }

  const act = async (action: () => Promise<unknown>): Promise<boolean> => {
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
      shell?.refresh()
    }
  }

  return (
    <main>
      <h1>{t('nav.people')}</h1>
      {settled && <p className="muted">{t('event.settledNote')}</p>}
      {!online && isOwner && <p role="status" className="muted">{t('people.offline')}</p>}
      {!online && canAddPeople && !isOwner && <p role="status" className="muted">{t('people.offlineAdd')}</p>}
      {errorCode && <p className="form-error" role="alert">{t(`actionError.${errorCode}`, { defaultValue: t('actionError.action_failed') })}</p>}
      <ul className="plain-list row-list" aria-label={t('people.listLabel')}>
        {home.members.map(member => {
          const label = labels.get(member.userId) ?? member.displayName
          const you = member.userId === home.me.userId
          return (
            <li key={member.userId} className="expense-row person-row">
              <span>{you ? t('people.you', { name: label }) : label}</span>
              <span className="person-row__badges">
                {member.isGuest && <span className="role-badge">{t('people.guest')}</span>}
                <span className="role-badge">{t(`people.role.${member.role}`)}</span>
              </span>
              {canAddPeople && member.isGuest && (
                <button
                  type="button"
                  className="pill"
                  disabled={busy || !online}
                  onClick={() => void act(() => createEventRepository().removeGuest(eventId, member.userId))}
                >
                  {t('people.removeGuest', { name: label })}
                </button>
              )}
              {isOwner && member.role !== 'owner' && !member.isGuest && (
                <button
                  type="button"
                  className="pill"
                  disabled={busy || !online}
                  onClick={() => void changeRole(member.userId, member.role === 'cohost' ? 'participant' : 'cohost')}
                >
                  {member.role === 'cohost'
                    ? t('people.makeParticipant', { name: label })
                    : t('people.makeCohost', { name: label })}
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {canAddPeople && (
        <section aria-labelledby="add-person-title">
          <h2 id="add-person-title">{t('people.addPersonTitle')}</h2>
          <AddPersonForm
            disabled={busy || !online}
            onAdd={name => act(() => createEventRepository().addGuest(eventId, name))}
          />
        </section>
      )}
      <h2>{t('event.invite')}</h2>
      <InvitePanel eventId={eventId} eventName={home.event.name} />
    </main>
  )
}
