import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckIcon, CloseIcon } from '../../components/icons'
import { formatMoney } from '../../domain/money'
import type { EventRole, SplitMethod } from '../../domain/types'
import { PaysList } from './PaysList'
import { paysRows, sharedEachText, signedMoney } from './shareText'

export type ClaimItemView = {
  id: string
  description: string
  quantity: number
  totalCents: number
  /** Current allocations of this item (server-computed integer cents). */
  claims: Array<{ userId: string; amountCents: number }>
  /** True when a manager/creator assigned the item (self-claims are then not possible). */
  assigned: boolean
}

type Props = {
  role: EventRole
  currentUserId: string
  participants: Array<{ id: string; name: string }>
  items: ClaimItemView[]
  splitMethod?: SplitMethod
  claimingClosed?: boolean
  /** Owner/co-host or the expense creator; defaults to role !== 'participant'. */
  canManage?: boolean
  currency?: string
  /** No internet: every mutation is disabled. */
  offline?: boolean
  /** An action is in flight. */
  busy?: boolean
  /** The event is settled: everything is read-only. */
  settled?: boolean
  errorMessage?: string
  /** Discounts, tax and rounding of the bill (net signed cents, 0 = none); totalCents is then the amount paid. */
  adjustmentCents?: number
  totalCents?: number
  onClaim?: (itemId: string) => void
  onUnclaim?: (itemId: string) => void
  /**
   * One or more members; the server splits the item equally between them. Resolve false when it failed:
   * the picked people then stay selected.
   */
  onAssign?: (itemId: string, memberIds: string[]) => Promise<boolean> | void
  onToggleClosed?: (closed: boolean) => void
}

export function ClaimItemsPage({
  role,
  currentUserId,
  participants,
  items,
  splitMethod = 'item_claim',
  claimingClosed = false,
  canManage,
  currency = 'MYR',
  offline = false,
  busy = false,
  settled = false,
  errorMessage,
  adjustmentCents = 0,
  totalCents,
  onClaim,
  onUnclaim,
  onAssign,
  onToggleClosed,
}: Props) {
  const { t, i18n } = useTranslation()
  // item id -> people picked but not yet assigned. Missing = the item's current assignees.
  const [picking, setPicking] = useState<Record<string, string[]>>({})
  const manage = !settled && (canManage ?? role !== 'participant')
  const locked = offline || busy
  const money = (cents: number) => formatMoney(cents, currency, i18n.language)
  const nameOf = (id: string) => participants.find(p => p.id === id)?.name ?? '?'

  const shares = new Map<string, number>()
  let unallocated = 0
  for (const item of items) {
    const allocated = item.claims.reduce((sum, c) => sum + c.amountCents, 0)
    unallocated += item.totalCents - allocated
    for (const c of item.claims) shares.set(c.userId, (shares.get(c.userId) ?? 0) + c.amountCents)
  }
  // With an amount paid different from the items, what each person pays is the amount paid split over their items (owedShares), once
  // every item has someone; until then only the item amounts are shown.
  const itemsCents = items.reduce((sum, item) => sum + item.totalCents, 0)
  const paidCents = totalCents ?? itemsCents + adjustmentCents
  const pays = adjustmentCents !== 0 && unallocated === 0 ? paysRows(paidCents, Object.fromEntries(shares), participants) : []

  const togglePick = (itemId: string, current: string[], userId: string) =>
    setPicking(p => {
      const ids = p[itemId] ?? current
      return { ...p, [itemId]: ids.includes(userId) ? ids.filter(id => id !== userId) : [...ids, userId] }
    })
  const assign = async (itemId: string, memberIds: string[]) => {
    if ((await onAssign?.(itemId, memberIds)) === false) return
    setPicking(p => {
      const next = { ...p }
      delete next[itemId]
      return next
    })
  }

  return (
    <main>
      <h1>{t('claim.title')}</h1>
      {errorMessage && <p className="form-error" role="alert">{errorMessage}</p>}
      {settled && <p className="note">{t('event.settledNote')}</p>}
      {offline && !settled && <p className="note" role="status">{t('claim.offline')}</p>}
      {claimingClosed && <p className="note">{t('claim.closedNote')}</p>}
      {manage && (
        <div className="claim-toolbar">
          <button type="button" disabled={locked} onClick={() => onToggleClosed?.(!claimingClosed)}>
            {claimingClosed ? t('claim.reopen') : t('claim.close')}
          </button>
        </div>
      )}
      {items.length === 0 && <p className="muted">{t('claim.noItems')}</p>}
      <div className="row-list">
      {items.map(item => {
        const mine = item.claims.some(c => c.userId === currentUserId)
        const names = item.claims.map(c => nameOf(c.userId)).join(', ')
        const current = item.claims.map(c => c.userId)
        const picked = picking[item.id] ?? current
        const changed = picked.length > 0 && (picked.length !== current.length || picked.some(id => !current.includes(id)))
        return (
          <article key={item.id} className={mine ? 'claim-item claim-item--mine' : 'claim-item'}>
            <div className="expense-row">
              <span>{item.quantity > 1 ? `${item.description} ×${item.quantity}` : item.description}</span>
              <strong>{money(item.totalCents)}</strong>
            </div>
            <p className="note">
              {item.claims.length === 0
                ? t('claim.nobody')
                : item.assigned
                  ? t('claim.assignedTo', { names })
                  : t('claim.claimedBy', { names })}
            </p>
            {item.claims.length > 1 && <p className="note">{sharedEachText(t, money, item.totalCents, item.claims.length)}</p>}
            {splitMethod === 'item_claim' && !item.assigned && !settled && (
              <button
                type="button"
                className={mine ? 'chip' : 'chip primary'}
                disabled={locked || claimingClosed}
                onClick={() => (mine ? onUnclaim?.(item.id) : onClaim?.(item.id))}
              >
                {mine ? <CloseIcon /> : <CheckIcon />}
                {mine ? t('claim.unclaim') : t('claim.claimForMe')}
              </button>
            )}
            {manage && (
              <div className="claim-assign">
                <span id={`who-had-${item.id}`} className="field__label">{t('claim.whoHad', { item: item.description })}</span>
                <div className="who-had__people" role="group" aria-labelledby={`who-had-${item.id}`}>
                  {participants.map(p => {
                    const on = picked.includes(p.id)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className="chip toggle-chip"
                        aria-pressed={on}
                        disabled={locked}
                        onClick={() => togglePick(item.id, current, p.id)}
                      >
                        {on && <CheckIcon />}
                        {p.name}
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  className="chip primary claim-assign__go"
                  aria-label={t('claim.assignItem', { item: item.description })}
                  disabled={locked || !changed}
                  onClick={() => void assign(item.id, picked)}
                >
                  {t('claim.assign')}
                </button>
              </div>
            )}
          </article>
        )
      })}
      </div>
      <section className="receipt" aria-labelledby="claim-shares-title">
        <div className="receipt__paper">
          <h2 id="claim-shares-title" className="receipt__title">{t('claim.sharesTitle')}</h2>
          {pays.length > 0 ? (
            <PaysList rows={pays} label={t('claim.sharesTitle')} money={money} />
          ) : (
            <ul className="plain-list" aria-label={t('claim.sharesTitle')}>
              {participants.filter(p => (shares.get(p.id) ?? 0) > 0).map(p => (
                <li key={p.id} className="expense-row">
                  <span>{p.name}</span>
                  <strong>{money(shares.get(p.id) ?? 0)}</strong>
                </li>
              ))}
            </ul>
          )}
          {adjustmentCents !== 0 && (
            <>
              <hr className="receipt__rule" />
              <p className="expense-row"><span>{t('editor.paid.items')}</span> <span className="amount">{money(itemsCents)}</span></p>
              <p className="expense-row"><span>{t('editor.paid.line')}</span> <span className="amount">{signedMoney(money, adjustmentCents)}</span></p>
              <p className="expense-row receipt__paid"><span>{t('editor.paid.label')}</span> <strong className="amount">{money(paidCents)}</strong></p>
              {pays.length === 0 && <p className="note">{t('claim.paysWaiting')}</p>}
            </>
          )}
          {unallocated > 0 && (
            <>
              <hr className="receipt__rule" />
              <p className="note">{t('claim.unclaimedTotal', { amount: money(unallocated) })}</p>
            </>
          )}
        </div>
      </section>
    </main>
  )
}
