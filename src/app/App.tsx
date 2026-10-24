import { useTranslation } from 'react-i18next'
import '../styles/tokens.css'

export function App() {
  const { t, i18n } = useTranslation()
  return (
    <main className="app-shell">
      <div className="language-switch" role="group" aria-label={t('language.label')}>
        <button onClick={() => void i18n.changeLanguage('en')}>English</button>
        <button onClick={() => void i18n.changeLanguage('zh-CN')}>简体中文</button>
      </div>
      <h1>{t('home.chooseMode')}</h1>
      <button>{t('home.singleBill')}</button>
      <button>{t('home.tripEvent')}</button>
    </main>
  )
}
