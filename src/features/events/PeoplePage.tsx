import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useOutletContext, useParams } from 'react-router-dom'
import type { ShellContext } from '../../components/shellContext'
import { ActionError } from '../expenses/claimRepository'
import { useOnline } from '../../lib/useOnline'
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
  const isOwner = home.me.role === 'owner'

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

  return (
    <main>
      <h1>{t('nav.people')}</h1>
      {!online && isOwner && <p role="status" className="muted">{t('people.offline')}</p>}
      {errorCode && <p className="form-error" role="alert">{t(`actionError.${errorCode}`)}</p>}
      <ul className="plain-list">
        {home.members.map(member => {
          const label = labels.get(member.userId) ?? member.displayName
          const you = member.userId === home.me.userId
          return (
            <li key={member.userId} className="expense-row">
              <span>{you ? t('people.you', { name: label }) : label}</span>
              <span className="role-badge">{t(`people.role.${member.role}`)}</span>
              {isOwner && member.role !== 'owner' && (
                <button
                  type="button"
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
      <h2>{t('event.invite')}</h2>
      <InvitePanel eventId={eventId} />
    </main>
  )
}
