import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckIcon, CloseIcon } from '../../components/icons'
import { itemShares } from '../../domain/allocation'
import { formatMoney } from '../../domain/money'
import type { EventRole, SplitMethod } from '../../domain/types'
import { PaysList } from './PaysList'
import { paysRows, sharedEachText, signedMoney } from './shareText'
import { UnitStepper } from './UnitStepper'

// Quick taps on one item's chips or steppers within this time are saved as one call.
const SAVE_DELAY_MS = 400
// "Saved" is announced, then fades out of the way.
const SAVED_VISIBLE_MS = 3000

type Units = Record<string, number>

/** Ids or units (people with 0 units count as not there), in a form that compares by value. */
function canon(value: string[] | Units | number): string {
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return [...value].sort().join(',')
  return Object.entries(value)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, n]) => `${id}:${n}`)
    .join(',')
}

const withoutZeros = (units: Units): Units => Object.fromEntries(Object.entries(units).filter(([, n]) => n > 0))
const sum = (units: Units) => Object.values(units).reduce((total, n) => total + n, 0)

export type ClaimItemView = {
  id: string
  description: string
  quantity: number
  totalCents: number
  /** Current allocations of this item (server-computed integer cents; units on a quantity > 1 item). */
  claims: Array<{ userId: string; amountCents: number; units?: number | null }>
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
   * Saves who had the item (empty = nobody); the server splits it equally between them. Called a moment after
   * the last chip tap. Resolve once the page has the server's state: true when saved, false when it failed
   * (the chips then go back to the saved people).
   */
  onAssign?: (itemId: string, memberIds: string[]) => Promise<boolean> | void
  /** Quantity > 1 items: how many units I had (0 = none). Saved like the chips. */
  onClaimUnits?: (itemId: string, units: number) => Promise<boolean> | void
  /** Quantity > 1 items, managers: who had how many ({} = nobody). Saved like the chips. */
  onAssignUnits?: (itemId: string, units: Units) => Promise<boolean> | void
  onToggleClosed?: (closed: boolean) => void
}

type Pick = string[] | Units | number
// One pending pick per control: `assign:<item>` (chips or the managers' steppers) and `mine:<item>` (my stepper).
type PickKey = `assign:${string}` | `mine:${string}`

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
  onClaimUnits,
  onAssignUnits,
  onToggleClosed,
}: Props) {
  const { t, i18n } = useTranslation()
  // Picks tapped but not saved yet (missing = the saved state), and each item's save status.
  const [picking, setPicking] = useState<Partial<Record<PickKey, Pick>>>({})
  const [status, setStatus] = useState<Record<string, 'saving' | 'saved'>>({})
  const pickingRef = useRef(picking)
  const timers = useRef<Partial<Record<PickKey, ReturnType<typeof setTimeout>>>>({})
  const itemsRef = useRef(items) // the saved state when a delayed save runs
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  const callbacks = useRef({ onAssign, onClaimUnits, onAssignUnits })
  useEffect(() => {
    callbacks.current = { onAssign, onClaimUnits, onAssignUnits }
  }, [onAssign, onClaimUnits, onAssignUnits])
  const savedTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const mounted = useRef(true)

  /** The server's state for a pick key. */
  const savedPick = (key: PickKey): Pick => {
    const itemId = key.slice(key.indexOf(':') + 1)
    const item = itemsRef.current.find(i => i.id === itemId)
    if (!item) return []
    if (key.startsWith('mine:')) return item.claims.find(c => c.userId === currentUserId)?.units ?? 0
    if (item.quantity > 1) return Object.fromEntries(item.claims.map(c => [c.userId, c.units ?? 1]))
    return item.claims.map(c => c.userId)
  }
  const send = (key: PickKey, value: Pick) => {
    const itemId = key.slice(key.indexOf(':') + 1)
    const { onAssign: assign, onClaimUnits: claimUnits, onAssignUnits: assignUnits } = callbacks.current
    if (typeof value === 'number') return claimUnits?.(itemId, value)
    if (Array.isArray(value)) return assign?.(itemId, value)
    return assignUnits?.(itemId, withoutZeros(value))
  }

  useEffect(() => {
    mounted.current = true
    const pending = timers.current
    const saved = savedTimers.current
    return () => {
      mounted.current = false
      for (const timer of Object.values(saved)) clearTimeout(timer)
      // Leaving the page right after a tap still saves it (fire and forget).
      for (const [key, timer] of Object.entries(pending) as Array<[PickKey, ReturnType<typeof setTimeout>]>) {
        clearTimeout(timer)
        const picked = pickingRef.current[key]
        if (picked !== undefined && canon(picked) !== canon(savedPick(key))) void send(key, picked)
      }
    }
    // Runs once: everything it reads goes through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const manage = !settled && (canManage ?? role !== 'participant')
  const locked = offline || busy
  const money = (cents: number) => formatMoney(cents, currency, i18n.language)
  const nameOf = (id: string) => participants.find(p => p.id === id)?.name ?? '?'

  const shares = new Map<string, number>()
  let unallocated = 0
  for (const item of items) {
    const allocated = item.claims.reduce((total, c) => total + c.amountCents, 0)
    unallocated += item.totalCents - allocated
    for (const c of item.claims) shares.set(c.userId, (shares.get(c.userId) ?? 0) + c.amountCents)
  }
  // With an amount paid different from the items, what each person pays is the amount paid split over their items (owedShares), once
  // every item has someone; until then only the item amounts are shown.
  const itemsCents = items.reduce((total, item) => total + item.totalCents, 0)
  const paidCents = totalCents ?? itemsCents + adjustmentCents
  const pays = adjustmentCents !== 0 && unallocated === 0 ? paysRows(paidCents, Object.fromEntries(shares), participants) : []

  const setPick = (key: PickKey, value: Pick | null) => {
    const next = { ...pickingRef.current }
    if (value !== null) next[key] = value
    else delete next[key]
    pickingRef.current = next
    setPicking(next)
  }
  const setItemStatus = (itemId: string, value: 'saving' | 'saved' | null) => {
    clearTimeout(savedTimers.current[itemId])
    if (value === 'saved') savedTimers.current[itemId] = setTimeout(() => mounted.current && setItemStatus(itemId, null), SAVED_VISIBLE_MS)
    setStatus(previous => {
      const next = { ...previous }
      if (value) next[itemId] = value
      else delete next[itemId]
      return next
    })
  }

  const save = async (key: PickKey) => {
    delete timers.current[key]
    const itemId = key.slice(key.indexOf(':') + 1)
    const picked = pickingRef.current[key]
    if (picked === undefined || canon(picked) === canon(savedPick(key))) return setPick(key, null) // tapped back
    setItemStatus(itemId, 'saving')
    const ok = (await send(key, picked)) !== false
    if (!mounted.current) return
    // Either way the page now shows the server's state.
    setPick(key, null)
    setItemStatus(itemId, ok ? 'saved' : null)
  }

  // Each tap saves; quick taps on the same control are sent as one call.
  const pick = (key: PickKey, itemId: string, value: Pick) => {
    if (status[itemId] === 'saving') return // aria-disabled: keeps focus, ignores the tap
    setPick(key, value)
    setItemStatus(itemId, null)
    clearTimeout(timers.current[key])
    timers.current[key] = setTimeout(() => void save(key), SAVE_DELAY_MS)
  }

  const shareOf = (item: ClaimItemView, units: Units, id: string) => {
    // Claims saved before units existed keep the server's equal split until someone changes them.
    if (item.claims.some(c => c.units == null) && canon(units) === canon(Object.fromEntries(item.claims.map(c => [c.userId, c.units ?? 1])))) {
      return item.claims.find(c => c.userId === id)?.amountCents ?? 0
    }
    const counted = withoutZeros(units)
    if (!(id in counted) || sum(counted) > item.quantity) return 0
    return itemShares(item, Object.keys(counted), counted)[id] ?? 0
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
        const byUnit = item.quantity > 1
        const names = item.claims
          .map(c => (byUnit ? t('claim.nameUnits', { name: nameOf(c.userId), count: c.units ?? 1 }) : nameOf(c.userId)))
          .join(', ')
        const saving = status[item.id] === 'saving'
        const canSelfClaim = splitMethod === 'item_claim' && !item.assigned && !settled
        const assignKey: PickKey = `assign:${item.id}`
        const mineKey: PickKey = `mine:${item.id}`
        const savedUnits: Units = Object.fromEntries(item.claims.map(c => [c.userId, c.units ?? 1]))
        // Units as shown: the managers' pending pick, else my pending count on top of the saved claims.
        const myPick = picking[mineKey] as number | undefined
        const shownUnits: Units = (picking[assignKey] as Units | undefined) ??
          (myPick !== undefined ? { ...savedUnits, [currentUserId]: myPick } : savedUnits)
        const left = item.quantity - sum(withoutZeros(shownUnits))
        const current = item.claims.map(c => c.userId)
        const picked = (picking[assignKey] as string[] | undefined) ?? current
        // With the self stepper shown, the manager's own row would be a second control for the same person.
        const unitRows = byUnit ? participants.filter(p => !(canSelfClaim && p.id === currentUserId)) : []
        const statusLine = (
          <p className="note claim-assign__status" aria-live="polite">
            {status[item.id] ? t(status[item.id] === 'saving' ? 'claim.saving' : 'claim.saved') : ''}
          </p>
        )
        return (
          <article key={item.id} className={mine ? 'claim-item claim-item--mine' : 'claim-item'}>
            <div className="expense-row">
              <span>{item.description}</span>
              <strong>{money(item.totalCents)}</strong>
            </div>
            {byUnit && (
              <p className="note claim-item__units">
                <span>{t('claim.unitPrice', { count: item.quantity, price: money(Math.round(item.totalCents / item.quantity)) })}</span>
                <span aria-live="polite">{left > 0 ? t('claim.unitsLeft', { left, count: item.quantity }) : t('claim.noneLeft')}</span>
              </p>
            )}
            <p className="note">
              {item.claims.length === 0
                ? t('claim.nobody')
                : item.assigned
                  ? t('claim.assignedTo', { names })
                  : t('claim.claimedBy', { names })}
            </p>
            {!byUnit && item.claims.length > 1 && <p className="note">{sharedEachText(t, money, item.totalCents, item.claims.length)}</p>}
            {canSelfClaim && !byUnit && (
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
            {canSelfClaim && byUnit && (
              <div className="claim-assign">
                <span className="field__label">{t('claim.howMany')}</span>
                <UnitStepper
                  label={t('claim.unitsMine', { item: item.description })}
                  value={shownUnits[currentUserId] ?? 0}
                  max={(shownUnits[currentUserId] ?? 0) + left}
                  disabled={locked || claimingClosed}
                  pending={saving}
                  onChange={n => pick(mineKey, item.id, n)}
                >
                  {money(shareOf(item, shownUnits, currentUserId))}
                </UnitStepper>
                {!(manage && unitRows.length > 0) && statusLine}
              </div>
            )}
            {manage && !(byUnit && unitRows.length === 0) && (
              <div className="claim-assign">
                <span id={`who-had-${item.id}`} className="field__label">{t('claim.whoHad', { item: item.description })}</span>
                {byUnit ? (
                  <div className="unit-list" role="group" aria-labelledby={`who-had-${item.id}`}>
                    {unitRows.map(p => (
                      <div key={p.id} className="unit-row">
                        <span className="unit-row__name">{p.name}</span>
                        <UnitStepper
                          label={t('claim.unitsFor', { name: p.name, item: item.description })}
                          value={shownUnits[p.id] ?? 0}
                          max={(shownUnits[p.id] ?? 0) + left}
                          disabled={locked}
                          pending={saving}
                          onChange={n => pick(assignKey, item.id, { ...shownUnits, [p.id]: n })}
                        >
                          {money(shareOf(item, shownUnits, p.id))}
                        </UnitStepper>
                      </div>
                    ))}
                  </div>
                ) : (
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
                          aria-disabled={saving || undefined}
                          onClick={() => pick(assignKey, item.id, on ? picked.filter(id => id !== p.id) : [...picked, p.id])}
                        >
                          {on && <CheckIcon />}
                          {p.name}
                        </button>
                      )
                    })}
                  </div>
                )}
                {statusLine}
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
