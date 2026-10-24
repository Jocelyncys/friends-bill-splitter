import { useTranslation } from 'react-i18next'
import type { EventHomeState } from './useEventHome'

/** Loading / error placeholder shared by every page that depends on the event home. */
export function EventStatus({ state }: { state: Exclude<EventHomeState, { status: 'ready' }> }) {
  const { t } = useTranslation()
  if (state.status === 'loading') return <p role="status">{t('common.loading')}</p>
  return <p role="alert">{state.error === 'not_member' ? t('event.notMember') : t('event.loadFailed')}</p>
}
