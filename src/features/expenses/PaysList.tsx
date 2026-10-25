import { useTranslation } from 'react-i18next'
import type { PaysRow } from './shareText'

/** Each person's items subtotal and what they pay once the voucher, tax and rounding are spread over it. */
export function PaysList({ rows, label, money }: { rows: PaysRow[]; label: string; money: (cents: number) => string }) {
  const { t } = useTranslation()
  return (
    <ul className="plain-list pays-list" aria-label={label}>
      {rows.map(row => (
        <li key={row.userId} className="expense-row">
          <span>
            {row.name}
            <small>{t('claim.paysLine', { items: money(row.itemsCents), pays: money(row.paysCents) })}</small>
          </span>
          <strong>{money(row.paysCents)}</strong>
        </li>
      ))}
    </ul>
  )
}
