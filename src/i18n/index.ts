import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import zhCN from './zh-CN.json'

const STORAGE_KEY = 'preferredLanguage'

const SUPPORTED = ['en', 'zh-CN']

function readSaved(): string | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved && SUPPORTED.includes(saved) ? saved : null
  } catch {
    return null
  }
}

const detected = navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, 'zh-CN': { translation: zhCN } },
  lng: readSaved() ?? detected,
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

i18n.on('languageChanged', language => {
  try {
    localStorage.setItem(STORAGE_KEY, language)
  } catch {
    // storage unavailable (private mode); preference just won't persist
  }
})

export default i18n
