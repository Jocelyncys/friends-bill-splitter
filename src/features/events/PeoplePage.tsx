import { useTranslation } from 'react-i18next'

// Placeholder until Task 7 (people, claiming and roles).
export function PeoplePage() {
  const { t } = useTranslation()
  return (
    <main>
      <h1>{t('nav.people')}</h1>
      <p>{t('people.comingSoon')}</p>
    </main>
  )
}
