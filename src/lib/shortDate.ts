/** "26 Oct" in English (day first, as in Malaysia), "10月26日" in Chinese. */
export function shortDate(date: Date, language: string): string {
  const locale = language.startsWith('zh') ? 'zh-CN' : 'en-GB'
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(date)
}
