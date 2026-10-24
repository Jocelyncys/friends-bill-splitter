import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import type { EventMode } from '../../domain/types'
import { ensureAnonymousSession } from '../auth/anonymousSession'
import { createEventRepository } from './eventRepository'
import { readPreferredName } from './preferredName'

const MODES: EventMode[] = ['single_bill', 'trip_event']

export function CreateEventPage() {
  const { mode } = useParams()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState(readPreferredName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!MODES.includes(mode as EventMode)) return <Navigate to="/" replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !displayName.trim()) return setError(t('create.nameRequired'))
    setBusy(true)
    setError(null)
    try {
      await ensureAnonymousSession()
      const { eventId, inviteToken } = await createEventRepository().createEvent({
        name: name.trim(),
        mode: mode as EventMode,
        currency: 'MYR',
        displayName: displayName.trim(),
      })
      try {
        localStorage.setItem(`inviteToken:${eventId}`, inviteToken)
      } catch {
        // storage unavailable; the invite link just cannot be re-shown later
      }
      navigate(`/event/${eventId}`)
    } catch {
      setError(t('create.failed'))
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>{t('create.title')}</h1>
      <form className="form" onSubmit={e => void submit(e)}>
        <label>
          {t('create.eventName')}
          <input value={name} onChange={e => setName(e.target.value)} autoComplete="off" />
        </label>
        <label>
          {t('common.yourName')}
          <input value={displayName} onChange={e => setDisplayName(e.target.value)} autoComplete="name" />
        </label>
        {error && <p role="alert" className="form-error">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>{busy ? t('create.submitting') : t('create.submit')}</button>
      </form>
    </main>
  )
}
