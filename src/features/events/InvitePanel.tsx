import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckIcon, LinkIcon } from '../../components/icons'

function readToken(eventId: string): string | null {
  try {
    return localStorage.getItem(`inviteToken:${eventId}`)
  } catch {
    return null
  }
}

/** `token` is passed only right after creating an event whose token could not be stored on this device. */
export function InvitePanel({
  eventId,
  eventName,
  token: unsavedToken,
}: {
  eventId: string
  eventName: string
  token?: string
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  // Share fell back to copying: say so next to the Share button.
  const [shareCopied, setShareCopied] = useState(false)
  const token = unsavedToken ?? readToken(eventId)
  if (!token) return <p className="note">{t('event.inviteOnlyOnCreatorDevice')}</p>
  const url = `${window.location.origin}${window.location.pathname}#/join/${token}`
  const writeLink = async () => {
    try {
      await navigator.clipboard.writeText(url)
      return true
    } catch {
      return false // clipboard blocked; the link stays selectable in the field
    }
  }
  const copy = async () => setCopied(await writeLink())
  const share = async () => {
    setShareCopied(false)
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: eventName, text: t('event.inviteText', { name: eventName }), url })
        return
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return // sheet closed by the user
      }
    }
    setShareCopied(await writeLink())
  }
  return (
    <section className="invite-panel">
      {unsavedToken && <p role="alert" className="form-error">{t('event.inviteNotSaved')}</p>}
      <button type="button" className="primary invite-panel__share" onClick={() => void share()}>
        <LinkIcon />
        {t('event.shareInvite')}
      </button>
      <p role="status" className="invite-panel__status">{shareCopied ? t('common.copied') : ''}</p>
      <div className="group">
        <label className="field">
          <span className="field__label">{t('event.inviteLinkLabel')}</span>
          <input readOnly value={url} onFocus={e => e.currentTarget.select()} />
        </label>
        <button type="button" className="pill" onClick={() => void copy()}>
          {copied && <CheckIcon />}
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
    </section>
  )
}
