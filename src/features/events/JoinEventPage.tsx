import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { ensureAnonymousSession } from '../auth/anonymousSession'
import { createEventRepository, type InviteGuest } from './eventRepository'
import { readPreferredName } from './preferredName'

export function JoinEventPage() {
  const { token = '' } = useParams()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [displayName, setDisplayName] = useState(readPreferredName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // People the host added by name; the joiner may be one of them ('' = new person).
  const [guests, setGuests] = useState<InviteGuest[]>([])
  const [guestId, setGuestId] = useState('')

  useEffect(() => {
    let cancelled = false
    createEventRepository()
      .listInviteGuests(token)
      .then(
        list => !cancelled && setGuests(list),
        () => {}, // only a shortcut: joining as a new person still works
      )
    return () => {
      cancelled = true
    }
  }, [token])

  const pickGuest = (id: string) => {
    setGuestId(id)
    const guest = guests.find(g => g.memberId === id)
    if (guest) setDisplayName(guest.displayName)
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!displayName.trim()) return setError(t('join.nameRequired'))
    setBusy(true)
    setError(null)
    try {
      await ensureAnonymousSession()
      const eventId = await createEventRepository().joinEvent(token, displayName, guestId || undefined)
      navigate(`/event/${eventId}`)
    } catch (err) {
      const message = typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : ''
      setError(
        message === 'invalid_invite'
          ? t('join.invalidInvite')
          : message === 'already_member'
            ? t('actionError.already_member')
            : t('join.failed'),
      )
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>{t('join.title')}</h1>
      <form className="form" onSubmit={e => void submit(e)}>
        {guests.length > 0 && (
          <fieldset className="group">
            <legend className="field__label">{t('join.guestQuestion')}</legend>
            <p className="note">{t('join.guestHint')}</p>
            <div className="guest-picks">
              {guests.map(guest => (
                <label key={guest.memberId} className="guest-pick">
                  <input
                    type="radio"
                    name="guest"
                    checked={guestId === guest.memberId}
                    onChange={() => pickGuest(guest.memberId)}
                  />
                  {guest.displayName}
                </label>
              ))}
              <label className="guest-pick">
                <input type="radio" name="guest" checked={guestId === ''} onChange={() => setGuestId('')} />
                {t('join.guestNone')}
              </label>
            </div>
          </fieldset>
        )}
        <div className="group">
          <label className="field">
            <span className="field__label">{t('common.yourName')}</span>
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} autoComplete="name" />
          </label>
        </div>
        {error && <p role="alert" className="form-error">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>{busy ? t('join.submitting') : t('join.submit')}</button>
      </form>
    </main>
  )
}
