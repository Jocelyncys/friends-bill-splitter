import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { formatMoney } from '../../domain/money'
import { deleteDraft } from './draftDb'
import { useDrafts } from './useDrafts'

/** Expenses saved on this device for one event: waiting to sync, or refused by the server. */
export function DraftList({ eventId, currency }: { eventId: string; currency: string }) {
  const { t, i18n } = useTranslation()
  const drafts = useDrafts(eventId)
  const [discarding, setDiscarding] = useState<string | null>(null)
  if (drafts.length === 0) return null
  return (
    <section aria-label={t('drafts.title')}>
      <h2>{t('drafts.title')}</h2>
      <p role="status" className="muted">{t('drafts.note')}</p>
      {drafts.map(draft => (
        <article key={draft.id} className="expense-row">
          <div>
            <span>{draft.payload.description}</span>
            <small>{draft.status === 'failed' ? t('drafts.failed') : draft.status === 'syncing' ? t('drafts.syncing') : t('drafts.pending')}</small>
            {draft.status === 'failed' && (
              <small role="alert">{t(`expenseError.${draft.errorCode}`, { defaultValue: t('expenseError.save_failed') })}</small>
            )}
          </div>
          <strong>{formatMoney(draft.payload.totalCents, currency, i18n.language)}</strong>
          {draft.status === 'failed' && (
            <>
              <Link to={`/event/${eventId}/expenses/new?draft=${draft.id}`}>{t('drafts.review')}</Link>
              <button type="button" onClick={() => setDiscarding(draft.id)}>{t('drafts.discard')}</button>
            </>
          )}
        </article>
      ))}
      {discarding && (
        <ConfirmDialog
          title={t('drafts.discardTitle')}
          confirmLabel={t('drafts.discard')}
          onCancel={() => setDiscarding(null)}
          onConfirm={() => {
            void deleteDraft(discarding).finally(() => setDiscarding(null))
          }}
        >
          <p>{t('drafts.discardBody')}</p>
        </ConfirmDialog>
      )}
    </section>
  )
}
