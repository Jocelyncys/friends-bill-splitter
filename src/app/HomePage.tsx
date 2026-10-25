import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { ReceiptIcon, PeopleIcon } from '../components/icons'

export function HomePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <main>
      <h1>{t('home.chooseMode')}</h1>
      <p className="lede">{t('home.intro')}</p>
      <div className="guided-actions guided-actions--large">
        <button type="button" className="primary" onClick={() => navigate('/new/single_bill')}><ReceiptIcon />{t('home.singleBill')}</button>
        <button type="button" onClick={() => navigate('/new/trip_event')}><PeopleIcon />{t('home.tripEvent')}</button>
      </div>
    </main>
  )
}
