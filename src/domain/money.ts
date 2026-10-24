import type { MoneyCents } from './types'

export function cents(value: number): MoneyCents {
  if (!Number.isSafeInteger(value)) throw new Error('Money must be an integer number of cents')
  return value as MoneyCents
}

export function formatMoney(value: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value / 100)
}
