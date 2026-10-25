import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckIcon, CloseIcon } from '../../components/icons'
import { formatMoney } from '../../domain/money'
import type { EventRole, SplitMethod } from '../../domain/types'
import { PaysList } from './PaysList'
import { paysRows, sharedEachText } from './shareText'

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

/** A bill-level line (signed cents). */
export type ClaimAdjustmentView = { id: string; label: string; amountCents: number }

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
  /** Voucher, tax, rounding ... of the bill; with them, totalCents is the amount paid. */
  adjustments?: ClaimAdjustmentView[]
  totalCents?: number
  onClaim?: (itemId: string) => void
  onUnclaim?: (itemId: string) => void
  /** One or more members; the server splits the item equally between them. */
  onAssign?: (itemId: string, memberIds: string[]) => void
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
  adjustments = [],
  totalCents,
  onClaim,
  onUnclaim,
  onAssign,
  onToggleClosed,
}: Props) {
  const { t, i18n } = useTranslation()
  // item id -> people picked in the open "Share between people" panel.
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
  // With adjustments, what each person pays is the amount paid split over their items (owedShares), once
  // every item has someone; until then only the item amounts are shown.
  const itemsCents = items.reduce((sum, item) => sum + item.totalCents, 0)
  const paidCents = totalCents ?? itemsCents + adjustments.reduce((sum, a) => sum + a.amountCents, 0)
  const pays = adjustments.length > 0 && unallocated === 0 ? paysRows(paidCents, Object.fromEntries(shares), participants) : []

  const togglePick = (itemId: string, userId: string) =>
    setPicking(p => {
      const ids = p[itemId] ?? []
      return { ...p, [itemId]: ids.includes(userId) ? ids.filter(id => id !== userId) : [...ids, userId] }
    })
  const closePicker = (itemId: string) =>
    setPicking(p => {
      const next = { ...p }
      delete next[itemId]
      return next
    })

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
        const picked = picking[item.id]
        const pickerId = `who-had-${item.id}`
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
              <div className="claim-assign" role="group" aria-label={t('claim.assignGroup', { item: item.description })}>
                {participants.map(p => (
                  <button key={p.id} type="button" className="chip" disabled={locked} onClick={() => onAssign?.(item.id, [p.id])}>
                    {t('claim.assignTo', { name: p.name })}
                  </button>
                ))}
                <button
                  type="button"
                  className="chip claim-assign__share"
                  aria-expanded={picked !== undefined}
                  aria-controls={picked ? pickerId : undefined}
                  onClick={() =>
                    picked ? closePicker(item.id) : setPicking(p => ({ ...p, [item.id]: item.claims.map(c => c.userId) }))
                  }
                >
                  {t('claim.shareBetween')}
                </button>
              </div>
            )}
            {manage && picked && (
              <div id={pickerId} className="who-had who-had--claim">
                <div className="who-had__people" role="group" aria-label={t('claim.whoHad', { item: item.description })}>
                  {participants.map(p => {
                    const on = picked.includes(p.id)
                    return (
                      <button key={p.id} type="button" className="chip toggle-chip" aria-pressed={on} onClick={() => togglePick(item.id, p.id)}>
                        {on && <CheckIcon />}
                        {p.name}
                      </button>
                    )
                  })}
                </div>
                <button
                  type="button"
                  className="primary"
                  disabled={locked || picked.length === 0}
                  onClick={() => {
                    onAssign?.(item.id, picked)
                    closePicker(item.id)
                  }}
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
          {adjustments.length > 0 && (
            <>
              <hr className="receipt__rule" />
              <p className="expense-row"><span>{t('editor.adj.items')}</span> <span className="amount">{money(itemsCents)}</span></p>
              {adjustments.map(a => (
                <p key={a.id} className="expense-row"><span>{a.label}</span> <span className="amount">{money(a.amountCents)}</span></p>
              ))}
              <p className="expense-row receipt__paid"><span>{t('editor.adj.paid')}</span> <strong className="amount">{money(paidCents)}</strong></p>
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
