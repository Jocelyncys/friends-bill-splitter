import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

export function HomePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <main>
      <h1>{t('home.chooseMode')}</h1>
      <div className="guided-actions guided-actions--large">
        <button type="button" onClick={() => navigate('/new/single_bill')}>{t('home.singleBill')}</button>
        <button type="button" onClick={() => navigate('/new/trip_event')}>{t('home.tripEvent')}</button>
      </div>
    </main>
  )
}
