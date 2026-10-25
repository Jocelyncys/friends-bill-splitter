import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertIcon, CameraIcon, LinkIcon, PenIcon, ReceiptIcon } from '../../components/icons'
import { formatMoney } from '../../domain/money'
import type { Counterpart } from './myPosition'
import type { PositionView } from './useMyPosition'

type ExpenseSummary = { id: string; description: string; totalCents: number }
export type AttentionEntry = string | { id: string; label: string; onSelect: () => void }
type Props = {
  eventName: string
  expenses: ExpenseSummary[]
  attention: AttentionEntry[]
  currency?: string
  /** Sum of every expense in the event (the list only shows the latest few). */
  groupTotalCents?: number
  /** The current user's position (estimate before settlement); left out while loading. */
  position?: PositionView | null
  /** Display names by user id, for the position line. */
  names?: Record<string, string>
  onScanReceipt?: () => void
  onAddExpense?: () => void
  onInvite?: () => void
  /** Owner/co-host with expenses on an open event. */
  onSettle?: () => void
  /** Why Settle now is disabled (e.g. unsynced drafts); only meaningful with onSettle. */
  settleBlockedReason?: string
  /** Event is settled: expenses are read-only and payments take over. */
  settled?: boolean
  onViewPayments?: () => void
  onViewAll?: () => void
  children?: ReactNode
}

const LATEST = 3

export function EventHomePage({
  expenses,
  attention,
  currency = 'MYR',
  groupTotalCents,
  position,
  names = {},
  onScanReceipt,
  onAddExpense,
  onInvite,
  onSettle,
  settleBlockedReason,
  settled = false,
  onViewPayments,
  onViewAll,
  children,
}: Props) {
  const { t, i18n } = useTranslation()
  const latestId = useId()
  const empty = expenses.length === 0
  const showSettle = !settled && !!onSettle
  const money = (cents: number) => formatMoney(cents, currency, i18n.language)
  const total = groupTotalCents ?? expenses.reduce((sum, x) => sum + x.totalCents, 0)
  return (
    <main className="event-home">
      {!empty && position && <Position view={position} names={names} money={money} />}

      {!empty && (
        <section className="receipt" aria-labelledby={latestId}>
          <div className="receipt__paper">
            <h2 id={latestId} className="receipt__title">{t('event.latestExpenses')}</h2>
            {expenses.slice(0, LATEST).map(item => (
              <article key={item.id} className="expense-row">
                <span>{item.description}</span>
                <strong>{money(item.totalCents)}</strong>
              </article>
            ))}
            <hr className="receipt__rule" />
            <p className="receipt__total">
              <span>{t('event.groupTotal')}</span>
              <span className="receipt__leader" aria-hidden="true" />
              <span className="amount">{money(total)}</span>
            </p>
            {expenses.length > LATEST && onViewAll && (
              <button type="button" className="pill receipt__more" onClick={onViewAll}>{t('event.viewAll')}</button>
            )}
          </div>
        </section>
      )}

      <h1>{empty ? t('event.emptyTitle') : t('event.activeTitle')}</h1>
      <section className={empty ? 'guided-actions guided-actions--large' : 'guided-actions'}>
        {!settled && <button type="button" className="primary" onClick={onScanReceipt} disabled={!onScanReceipt}><CameraIcon /> {t('event.scanReceipt')}</button>}
        {!settled && <button type="button" onClick={onAddExpense} disabled={!onAddExpense}><PenIcon /> {t('event.addSimple')}</button>}
        <button type="button" className={empty ? 'quiet' : showSettle ? 'guided-actions__minor' : undefined} onClick={onInvite} disabled={!onInvite}><LinkIcon /> {t('event.invite')}</button>
        {showSettle && <button type="button" className="guided-actions__minor" onClick={onSettle} disabled={!!settleBlockedReason}><ReceiptIcon /> {t('event.settleNow')}</button>}
        {settled && <button type="button" className="primary" onClick={onViewPayments} disabled={!onViewPayments}><ReceiptIcon /> {t('event.viewPayments')}</button>}
      </section>
      {!settled && onSettle && settleBlockedReason && <p role="status" className="muted guided-hint">{settleBlockedReason}</p>}
      {settled && <p className="muted guided-hint">{t('event.settledNote')}</p>}
      {children}
      {attention.length > 0 && (
        <section className="attention">
          <h2><AlertIcon />{t('event.needsAttention')}</h2>
          <ul>
            {attention.map(item => {
              const label = typeof item === 'string' ? item : item.label
              const key = typeof item === 'string' ? item : item.id
              return (
                <li key={key}>
                  {typeof item === 'string' ? <p>{label}</p> : <button type="button" onClick={item.onSelect}>{label}</button>}
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </main>
  )
}

function Position({ view, names, money }: { view: PositionView; names: Record<string, string>; money: (cents: number) => string }) {
  const { t } = useTranslation()
  const nameOf = (id: string) => names[id] ?? t('settlement.formerMember')
  const { position, estimate } = view
  const note = <p className="muted position__note">{t(estimate ? 'event.position.estimate' : 'event.position.settled')}</p>

  if (position === 'waiting') {
    return (
      <section className="position" aria-label={t('event.position.label')}>
        <p className="position__label">{t('event.position.waiting')}</p>
      </section>
    )
  }
  if (position.owe.length === 0 && position.receive.length === 0) {
    return (
      <section className="position" aria-label={t('event.position.label')}>
        <p className="position__square">{t('event.position.square')}</p>
        {note}
      </section>
    )
  }
  const side = (kind: 'owe' | 'receive', list: Counterpart[]) => {
    if (list.length === 0) return null
    const sum = list.reduce((s, x) => s + x.amountCents, 0)
    const who = kind === 'owe' ? 'event.position.to' : 'event.position.from'
    return (
      <div>
        <p className="position__label">{t(kind === 'owe' ? 'event.position.owe' : 'event.position.receive')}</p>
        <p className="position__line">
          <span className="amount position__amount">{money(sum)}</span>
          {list.length === 1 && <span className="position__who">{t(who, { name: nameOf(list[0].userId) })}</span>}
        </p>
        {list.length > 1 && (
          <ul className="plain-list position__split">
            {list.map(x => (
              <li key={x.userId}>
                <span>{t(who, { name: nameOf(x.userId) })}</span>
                <span className="amount">{money(x.amountCents)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }
  return (
    <section className="position" aria-label={t('event.position.label')}>
      {side('owe', position.owe)}
      {side('receive', position.receive)}
      {note}
    </section>
  )
}
