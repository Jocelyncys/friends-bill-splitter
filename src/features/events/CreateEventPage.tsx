import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import type { EventMode } from '../../domain/types'
import { shortDate } from '../../lib/shortDate'
import { ensureAnonymousSession } from '../auth/anonymousSession'
import { createEventRepository } from './eventRepository'
import { readPreferredName } from './preferredName'

const MODES: EventMode[] = ['single_bill', 'trip_event']

export function CreateEventPage() {
  const { mode } = useParams()
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState(readPreferredName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!MODES.includes(mode as EventMode)) return <Navigate to="/" replace />

  const defaultName = t(mode === 'single_bill' ? 'create.defaultBill' : 'create.defaultTrip', {
    date: shortDate(new Date(), i18n.language),
  })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!displayName.trim()) return setError(t('create.nameRequired'))
    setBusy(true)
    setError(null)
    try {
      await ensureAnonymousSession()
      const { eventId, inviteToken } = await createEventRepository().createEvent({
        name: name.trim() || defaultName,
        mode: mode as EventMode,
        currency: 'MYR',
        displayName: displayName.trim(),
      })
      let stored = true
      try {
        localStorage.setItem(`inviteToken:${eventId}`, inviteToken)
      } catch {
        stored = false // storage unavailable: hand the link to the event page once, with a warning
      }
      const home = `/event/${eventId}`
      if (!stored) {
        await navigate(home, { state: { unsavedInviteToken: inviteToken } })
      } else if (mode === 'single_bill') {
        // A single bill starts at the receipt scan. The event home replaces this form, so Back lands there.
        await navigate(home, { replace: true })
        await navigate(`${home}/expenses/new?scan=1`)
      } else {
        // A trip starts by inviting friends, before anyone adds expenses.
        await navigate(home, { state: { showInvite: true } })
      }
    } catch {
      setError(t('create.failed'))
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>{t('create.title')}</h1>
      <form className="form" onSubmit={e => void submit(e)}>
        <div className="group">
          <label className="field">
            <span className="field__label">{t('create.eventName')}</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={defaultName}
              autoComplete="off"
            />
          </label>
          <label className="field">
            <span className="field__label">{t('common.yourName')}</span>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} autoComplete="name" />
          </label>
        </div>
        {error && <p role="alert" className="form-error">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>{busy ? t('create.submitting') : t('create.submit')}</button>
      </form>
    </main>
  )
}
