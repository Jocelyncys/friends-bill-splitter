import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet, useParams } from 'react-router-dom'
import { useEventRealtime } from '../features/events/useEventRealtime'
import { useUnsyncedWarning } from '../features/offline/useDrafts'
import { useDraftSync } from '../features/offline/useDraftSync'
import { HomeIcon, ListIcon, PeopleIcon } from './icons'
import type { ShellContext } from './shellContext'

// `short` is what the segmented control shows; `label` is the full name. The visible text is part of
// the accessible name ("中文" in "简体中文"), so voice control still works.
const LANGUAGES = [
  { code: 'en', label: 'English', short: 'English' },
  { code: 'zh-CN', label: '简体中文', short: '中文' },
] as const

export function AppShell() {
  const { t, i18n } = useTranslation()
  const { eventId } = useParams()
  const [eventName, setEventName] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const refresh = useCallback(() => setRefreshKey(key => key + 1), [])
  const realtimeStatus = useEventRealtime(eventId, refresh)
  const syncDrafts = useDraftSync(refresh)
  useUnsyncedWarning()
  const context: ShellContext = { setEventName, refreshKey, refresh, realtimeStatus, syncDrafts }

  useEffect(() => {
    document.documentElement.lang = i18n.language
  }, [i18n.language])

  return (
    <div className={eventId ? 'app-shell app-shell--event' : 'app-shell'}>
      <header className="app-header">
        <strong className="app-header__title">{eventId && eventName ? eventName : t('app.name')}</strong>
        <div className="language-switch" role="group" aria-label={t('language.label')}>
          {LANGUAGES.map(({ code, label, short }) => (
            <button
              key={code}
              type="button"
              lang={code}
              aria-label={label === short ? undefined : label}
              aria-pressed={i18n.language === code}
              onClick={() => void i18n.changeLanguage(code)}
            >
              {short}
            </button>
          ))}
        </div>
      </header>
      {eventId && realtimeStatus === 'offline' && (
        <p className="stale-banner" role="status">{t('realtime.offline')}</p>
      )}
      <div className="app-content">
        <Outlet context={context} />
      </div>
      {eventId && (
        <nav className="bottom-nav" aria-label={t('nav.label')}>
          <NavLink to={`/event/${eventId}`} end><HomeIcon />{t('nav.home')}</NavLink>
          <NavLink to={`/event/${eventId}/expenses`}><ListIcon />{t('nav.expenses')}</NavLink>
          <NavLink to={`/event/${eventId}/people`}><PeopleIcon />{t('nav.people')}</NavLink>
        </nav>
      )}
    </div>
  )
}
