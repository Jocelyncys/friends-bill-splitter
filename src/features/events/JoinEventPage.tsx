import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { ensureAnonymousSession } from '../auth/anonymousSession'
import { createEventRepository } from './eventRepository'
import { readPreferredName } from './preferredName'

export function JoinEventPage() {
  const { token = '' } = useParams()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [displayName, setDisplayName] = useState(readPreferredName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!displayName.trim()) return setError(t('join.nameRequired'))
    setBusy(true)
    setError(null)
    try {
      await ensureAnonymousSession()
      const eventId = await createEventRepository().joinEvent(token, displayName)
      navigate(`/event/${eventId}`)
    } catch (err) {
      const message = typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : ''
      setError(message === 'invalid_invite' ? t('join.invalidInvite') : t('join.failed'))
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>{t('join.title')}</h1>
      <form className="form" onSubmit={e => void submit(e)}>
        <label>
          {t('common.yourName')}
          <input value={displayName} onChange={e => setDisplayName(e.target.value)} autoComplete="name" />
        </label>
        {error && <p role="alert" className="form-error">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>{busy ? t('join.submitting') : t('join.submit')}</button>
      </form>
    </main>
  )
}
