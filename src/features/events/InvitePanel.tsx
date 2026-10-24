import { useState } from 'react'
import { useTranslation } from 'react-i18next'

function readToken(eventId: string): string | null {
  try {
    return localStorage.getItem(`inviteToken:${eventId}`)
  } catch {
    return null
  }
}

export function InvitePanel({ eventId }: { eventId: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const token = readToken(eventId)
  if (!token) return <p className="note">{t('event.inviteOnlyOnCreatorDevice')}</p>
  const url = `${window.location.origin}${window.location.pathname}#/join/${token}`
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // clipboard blocked; the link stays selectable in the field
    }
  }
  return (
    <section className="invite-panel">
      <label>
        {t('event.inviteLinkLabel')}
        <input readOnly value={url} onFocus={e => e.currentTarget.select()} />
      </label>
      <button type="button" onClick={() => void copy()}>{copied ? t('common.copied') : t('common.copy')}</button>
    </section>
  )
}
