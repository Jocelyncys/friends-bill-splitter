import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useOutletContext, useParams, useSearchParams } from 'react-router-dom'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { CameraIcon, CheckIcon, ImageIcon, PlusIcon, TrashIcon } from '../../components/icons'
import type { ShellContext } from '../../components/shellContext'
import { useOnline } from '../../lib/useOnline'
import { deleteDraft, getDraft, saveDraft } from '../offline/draftDb'
import { isTransientSaveError } from '../offline/syncDrafts'
import { formatMoney } from '../../domain/money'
import type { EventHome } from '../events/eventRepository'
import { EventStatus } from '../events/EventStatus'
import { displayNames } from '../events/memberNames'
import { useEventHome } from '../events/useEventHome'
import {
  buildPayload,
  centsToText,
  customDifference,
  draftFromPayload,
  itemCentsByPerson,
  parseMoneyToCents,
  validateDraft,
  type DraftItem,
  type DraftSplitMethod,
  type ExpenseDraft,
  type FormErrors,
} from './expenseForm'
import { createExpenseRepository, ExpenseSaveError, type SavedExpense, type SaveExpensePayload } from './expenseRepository'
import { recognizeReceipt } from '../ocr/ocrEngine'
import { PaysList } from './PaysList'
import { parseReceipt } from './receiptParser'
import { paysRows, sharedEachText, signedMoney } from './shareText'

const METHODS: DraftSplitMethod[] = ['equal', 'custom', 'items', 'host_assignment']

function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

type OcrState = 'idle' | 'recognizing' | 'review' | 'failed'

const isUntouched = (items: DraftItem[]) => items.length === 1 && items[0].description === '' && items[0].price === ''

const blankItem = (): DraftItem => ({ id: crypto.randomUUID(), description: '', price: '', assigneeIds: [] })

const isItemized = (method: DraftSplitMethod) => method === 'items' || method === 'host_assignment'

type Existing = { id: string; result: SavedExpense | 'failed' }

export function ExpenseEditorPage() {
  const { eventId = '', expenseId: editId } = useParams()
  const { t } = useTranslation()
  const draftId = useSearchParams()[0].get('draft')
  const state = useEventHome(eventId)
  // A saved expense being edited (/expenses/:expenseId/edit).
  const [existing, setExisting] = useState<Existing | null>(null)
  useEffect(() => {
    if (!editId) return
    let cancelled = false
    createExpenseRepository()
      .getExpense(editId)
      .then(
        result => !cancelled && setExisting({ id: editId, result }),
        () => !cancelled && setExisting({ id: editId, result: 'failed' }),
      )
    return () => {
      cancelled = true
    }
  }, [editId])
  // A saved draft being reopened (?draft=id). A missing draft opens a blank form.
  const [saved, setSaved] = useState<{ id: string; payload: SaveExpensePayload | null } | null>(null)
  useEffect(() => {
    if (!draftId) return
    let cancelled = false
    getDraft(draftId).then(
      found => !cancelled && setSaved({ id: draftId, payload: found?.payload ?? null }),
      () => !cancelled && setSaved({ id: draftId, payload: null }),
    )
    return () => {
      cancelled = true
    }
  }, [draftId])
  if (state.status !== 'ready') return <EventStatus state={state} />
  const { home } = state
  if (home.event.state === 'settled') {
    return (
      <main>
        <h1>{t(editId ? 'editor.editTitle' : 'editor.title')}</h1>
        <p className="muted">{t('event.settledNote')}</p>
        <Link to={`/event/${eventId}`}>{t('common.back')}</Link>
      </main>
    )
  }
  if (editId) {
    if (existing?.id !== editId) return <p role="status">{t('common.loading')}</p>
    const { result } = existing
    const allowed = result !== 'failed' && (home.me.role !== 'participant' || result.creatorUserId === home.me.userId)
    if (result === 'failed' || !allowed || result.payload.eventId !== eventId) {
      return (
        <main>
          <h1>{t('editor.editTitle')}</h1>
          <p role="alert" className="form-error">{t(result === 'failed' ? 'expenseError.expense_not_found' : 'expenseError.not_allowed')}</p>
          <Link to={`/event/${eventId}/expenses`}>{t('common.back')}</Link>
        </main>
      )
    }
    return <EditorForm key={`edit:${editId}`} home={home} saved={result.payload} claims={result.claims} editing />
  }
  if (draftId && saved?.id !== draftId) return <p role="status">{t('common.loading')}</p>
  return <EditorForm key={draftId ?? 'new'} home={home} saved={draftId ? saved?.payload ?? null : null} />
}

type EditorProps = {
  home: EventHome
  saved: SaveExpensePayload | null
  /** Editing a saved expense (not a local draft): Delete is offered and saving returns to the list. */
  editing?: boolean
  /** item id -> self-claimers; shown read-only, and such items never get allocations from this form. */
  claims?: Record<string, string[]>
}

function EditorForm({ home, saved, editing = false, claims = {} }: EditorProps) {
  const labels = displayNames(home.members)
  const nameOf = (userId: string, fallback: string) => labels.get(userId) ?? fallback
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const eventId = home.event.id
  const online = useOnline()
  const syncDrafts = useOutletContext<ShellContext | undefined>()?.syncDrafts
  // A reopened draft keeps its id: the server treats the resend as the same expense.
  const [expenseId] = useState(() => saved?.id ?? crypto.randomUUID())
  // Selects sit beside (not inside) their <label>: a wrapping label's text would include every option,
  // so e.g. "Custom amounts" made the split-method select match a search for the "Amount" field.
  const formId = useId()
  const [draft, setDraft] = useState<ExpenseDraft>(() => saved ? draftFromPayload(saved) : {
    description: '',
    amount: '',
    payerUserId: home.me.userId,
    expenseDate: today(),
    splitMethod: searchParams.get('scan') === '1' ? 'items' : 'equal',
    participantIds: home.members.map(m => m.userId),
    shares: {},
    items: [blankItem()],
  })
  const [errors, setErrors] = useState<FormErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [ocrState, setOcrState] = useState<OcrState>('idle')
  const [ocrMessage, setOcrMessage] = useState('')
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null)
  const receiptUrlRef = useRef<string | null>(null)
  const scanRun = useRef(0)

  useEffect(() => () => {
    scanRun.current += 1 // ignore any OCR result that arrives after unmount
    if (receiptUrlRef.current) URL.revokeObjectURL(receiptUrlRef.current)
  }, [])

  // Amount (equal/custom) and Amount paid (itemized) are one field, so switching method keeps what was typed.
  const changeMethod = (method: DraftSplitMethod) => {
    if (!isItemized(method)) {
      scanRun.current += 1 // drop any in-flight scan; the scan UI is going away
      setOcrState('idle')
      setOcrMessage('')
    }
    setDraft(d => {
      // An empty Amount paid means "the items total": equal/custom start from it. A typed amount carries over as is.
      if (isItemized(d.splitMethod) && !isItemized(method) && d.amount.trim() === '') {
        const items = d.items.reduce((sum, item) => sum + (parseMoneyToCents(item.price) ?? 0), 0)
        return { ...d, splitMethod: method, amount: items >= 1 ? centsToText(items) : '' }
      }
      return { ...d, splitMethod: method }
    })
  }

  const scanReceipt = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const run = ++scanRun.current
    if (receiptUrlRef.current) URL.revokeObjectURL(receiptUrlRef.current)
    const url = URL.createObjectURL(file)
    receiptUrlRef.current = url
    setReceiptUrl(url)
    setOcrState('recognizing')
    setOcrMessage(t('editor.scan.loadingModel'))
    try {
      const lines = await recognizeReceipt(file, phase => {
        if (run === scanRun.current) setOcrMessage(t(phase === 'loading' ? 'editor.scan.loadingModel' : 'editor.scan.recognizing'))
      })
      if (run !== scanRun.current) return
      const parsed = parseReceipt(lines)
      if (parsed.items.length === 0) throw new Error('no items')
      const scanned = parsed.items.map(item => ({ id: crypto.randomUUID(), description: item.description, price: centsToText(item.totalCents), assigneeIds: [] }))
      // The receipt's Total line is the amount paid. It only describes the scanned items, so it fills Amount paid
      // when they replace an empty form and differ from it.
      const scannedCents = parsed.items.reduce((sum, item) => sum + item.totalCents, 0)
      const total = parsed.totalCents
      setDraft(d => {
        if (!isUntouched(d.items)) return { ...d, items: [...d.items, ...scanned] }
        return { ...d, items: scanned, amount: total !== undefined && total !== scannedCents ? centsToText(total) : '' }
      })
      setOcrMessage(t('editor.scan.reviewHint'))
      setOcrState('review')
    } catch {
      if (run !== scanRun.current) return
      setOcrMessage(t('editor.scan.failed'))
      setOcrState('failed')
    }
  }

  const set = <K extends keyof ExpenseDraft>(key: K, value: ExpenseDraft[K]) => setDraft(d => ({ ...d, [key]: value }))
  const setItem = (index: number, patch: Partial<DraftItem>) =>
    set('items', draft.items.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  const toggleAssignee = (index: number, userId: string) => {
    const ids = draft.items[index].assigneeIds
    setItem(index, { assigneeIds: ids.includes(userId) ? ids.filter(id => id !== userId) : [...ids, userId] })
  }
  const money = (cents: number) => formatMoney(cents, home.event.currency, i18n.language)
  const fieldError = (key: keyof FormErrors) => (errors[key] ? <p className="field-error">{t(`editor.errors.${errors[key]}`)}</p> : null)

  const canPickPayer = home.me.role !== 'participant'
  const itemized = isItemized(draft.splitMethod)
  const reviewing = itemized && ocrState === 'review'
  const itemsTotal = draft.items.reduce((sum, item) => sum + (parseMoneyToCents(item.price) ?? 0), 0)
  // Amount paid, when typed, valid and different from the items: the difference is the discounts, tax and rounding.
  const paidCents = itemized ? parseMoneyToCents(draft.amount) : null
  const paidDifference = paidCents !== null && paidCents !== itemsTotal ? paidCents - itemsTotal : 0
  const difference = customDifference(draft.amount, draft.shares)
  const people = home.members.map(m => ({ id: m.userId, name: nameOf(m.userId, m.displayName) }))
  // Self-claimed items (friends-claim) count for their claimers: the server splits them with the same equal rule.
  const personItems =
    paidDifference !== 0
      ? itemCentsByPerson(draft.items.map(item => (item.assigneeIds.length > 0 ? item : { ...item, assigneeIds: claims[item.id] ?? [] })))
      : null
  const pays = personItems && paidCents !== null ? paysRows(paidCents, personItems, people) : []

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setServerError(null)
    const result = validateDraft(draft)
    if (!result.ok) return setErrors(result.errors)
    setErrors({})
    setBusy(true)
    const payload = buildPayload({ id: expenseId, eventId, category: saved?.category }, result.values)
    const done = editing ? `/event/${eventId}/expenses` : `/event/${eventId}`
    // Offline (or the network dropped mid-save): keep the reviewed payload on this device. Images are never stored.
    const keepOnDevice = async () => {
      try {
        await saveDraft(payload)
        navigate(done)
      } catch {
        setServerError(t('expenseError.draft_failed'))
        setBusy(false)
      }
    }
    if (!online) return keepOnDevice()
    try {
      await createExpenseRepository().saveExpense(payload)
      if (saved && !editing) await deleteDraft(expenseId).catch(() => undefined)
      navigate(done)
      void syncDrafts?.()
    } catch (err) {
      if (isTransientSaveError(err)) return keepOnDevice()
      const code = err instanceof ExpenseSaveError ? err.formError.code : 'save_failed'
      setServerError(t(`expenseError.${code}`, { defaultValue: t('expenseError.save_failed') }))
      setBusy(false)
    }
  }

  const deleteExpense = async () => {
    setConfirmingDelete(false)
    setServerError(null)
    setBusy(true)
    try {
      await createExpenseRepository().deleteExpense(expenseId)
      navigate(`/event/${eventId}/expenses`)
    } catch (err) {
      // A generic save_failed verdict would say "could not save": report it as a failed delete instead.
      const code = err instanceof ExpenseSaveError && err.formError.code !== 'save_failed' ? err.formError.code : 'delete_failed'
      setServerError(t(`expenseError.${code}`, { defaultValue: t('expenseError.delete_failed') }))
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>{t(editing ? 'editor.editTitle' : 'editor.title')}</h1>
      {!online && <p role="status" className="muted">{t('editor.offlineHint')}</p>}
      <form className="form" onSubmit={e => void submit(e)} noValidate>
        <div className="group">
          <label className="field">
            <span className="field__label">{t('editor.description')}</span>
            <input value={draft.description} onChange={e => set('description', e.target.value)} autoComplete="off" />
          </label>
          {fieldError('description')}

          {!itemized && (
            <>
              <label className="field">
                <span className="field__label">{t('editor.amount')}</span>
                <input inputMode="decimal" value={draft.amount} onChange={e => set('amount', e.target.value)} autoComplete="off" />
              </label>
              {fieldError('amount')}
            </>
          )}

          {canPickPayer ? (
            <div className="field">
              <label className="field__label" htmlFor={`${formId}-payer`}>{t('editor.payer')}</label>
              <select id={`${formId}-payer`} value={draft.payerUserId} onChange={e => set('payerUserId', e.target.value)}>
                {home.members.map(m => (
                  <option key={m.userId} value={m.userId}>{nameOf(m.userId, m.displayName)}</option>
                ))}
              </select>
            </div>
          ) : (
            <p className="field field--static"><span className="field__label">{t('editor.payer')}</span> <strong>{nameOf(draft.payerUserId, home.me.displayName)}</strong></p>
          )}
          {fieldError('payer')}

          <label className="field">
            <span className="field__label">{t('editor.date')}</span>
            <input type="date" value={draft.expenseDate} onChange={e => set('expenseDate', e.target.value)} />
          </label>
          {fieldError('date')}

          <div className="field">
            <label className="field__label" htmlFor={`${formId}-split`}>{t('editor.splitMethod')}</label>
            <select id={`${formId}-split`} value={draft.splitMethod} onChange={e => changeMethod(e.target.value as DraftSplitMethod)}>
              {METHODS.map(m => (
                <option key={m} value={m}>{t(`editor.method.${m}`)}</option>
              ))}
            </select>
          </div>
        </div>

        {draft.splitMethod === 'equal' && (
          <fieldset className="group">
            <legend className="group__legend">{t('editor.participants')}</legend>
            {home.members.map(m => (
              <label key={m.userId} className="field field--check">
                <input
                  type="checkbox"
                  checked={draft.participantIds.includes(m.userId)}
                  onChange={e =>
                    set('participantIds', e.target.checked ? [...draft.participantIds, m.userId] : draft.participantIds.filter(id => id !== m.userId))
                  }
                />
                {nameOf(m.userId, m.displayName)}
              </label>
            ))}
            {fieldError('participants')}
          </fieldset>
        )}

        {draft.splitMethod === 'custom' && (
          <fieldset className="group">
            <legend className="group__legend">{t('editor.participants')}</legend>
            {home.members.map(m => (
              <label key={m.userId} className="field">
                <span className="field__label">{t('editor.shareFor', { name: nameOf(m.userId, m.displayName) })}</span>
                <input
                  inputMode="decimal"
                  value={draft.shares[m.userId] ?? ''}
                  onChange={e => set('shares', { ...draft.shares, [m.userId]: e.target.value })}
                  autoComplete="off"
                />
              </label>
            ))}
            <p className="group__total" aria-live="polite">{t('editor.remaining', { amount: money(difference) })}</p>
            {fieldError('shares')}
          </fieldset>
        )}

        {itemized && (
          <fieldset className="group">
            <legend className="group__legend">{t('editor.items')}</legend>
            {/* Both feed the same OCR flow. capture="environment" opens the rear camera on phones; desktop
                browsers ignore it and show the file picker. */}
            <div className="group__actions photo-picks">
              <label className="file-pick">
                <CameraIcon />
                {t('editor.scan.takePhoto')}
                <input type="file" accept="image/*" capture="environment" onChange={e => void scanReceipt(e)} />
              </label>
              <label className="file-pick">
                <ImageIcon />
                {t('editor.scan.choosePhoto')}
                <input type="file" accept="image/*" onChange={e => void scanReceipt(e)} />
              </label>
            </div>
            {receiptUrl && <img className="receipt-preview" src={receiptUrl} alt={t('editor.scan.previewAlt')} />}
            <p className="group__status" aria-live="polite">{ocrState === 'idle' ? '' : ocrMessage}</p>
            {draft.items.map((item, index) => (
              <div key={item.id} className="item-row">
                <label className="field">
                  <span className="field__label">{t('editor.itemDescription', { n: index + 1 })}</span>
                  <input value={item.description} onChange={e => setItem(index, { description: e.target.value })} autoComplete="off" />
                </label>
                <label className="field">
                  <span className="field__label">{t('editor.itemPrice', { n: index + 1 })}</span>
                  <input inputMode="decimal" value={item.price} onChange={e => setItem(index, { price: e.target.value })} autoComplete="off" />
                </label>
                {draft.items.length > 1 ? (
                  <button type="button" className="quiet danger icon-button" onClick={() => set('items', draft.items.filter((_, i) => i !== index))}>
                    <TrashIcon />
                    <span className="sr-only">{t('editor.removeItem', { n: index + 1 })}</span>
                  </button>
                ) : <span aria-hidden="true" />}
                {draft.splitMethod === 'host_assignment' && (
                  <div className="who-had" role="group" aria-labelledby={`${formId}-who-${item.id}`}>
                    <span id={`${formId}-who-${item.id}`} className="field__label">{t('editor.whoHad', { n: index + 1 })}</span>
                    <div className="who-had__people">
                      {home.members.map(m => {
                        const on = item.assigneeIds.includes(m.userId)
                        return (
                          <button key={m.userId} type="button" className="chip toggle-chip" aria-pressed={on} onClick={() => toggleAssignee(index, m.userId)}>
                            {on && <CheckIcon />}
                            {nameOf(m.userId, m.displayName)}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
                {draft.splitMethod === 'items' && claims[item.id] && (
                  <p className="note">{t('claim.claimedBy', { names: claims[item.id].map(id => nameOf(id, '?')).join(', ') })}</p>
                )}
                {draft.splitMethod === 'items' && item.assigneeIds.length > 0 && (
                  <p className="note">{t('claim.assignedTo', { names: item.assigneeIds.map(id => nameOf(id, '?')).join(', ') })}</p>
                )}
                {item.assigneeIds.length > 1 && parseMoneyToCents(item.price) !== null && (
                  <p className="note">{sharedEachText(t, money, parseMoneyToCents(item.price) as number, item.assigneeIds.length)}</p>
                )}
              </div>
            ))}
            <div className="group__actions">
              <button type="button" className="add-row" onClick={() => set('items', [...draft.items, blankItem()])}><PlusIcon />{t('editor.addItem')}</button>
            </div>
            <p className="group__total">{t('editor.total')} <strong className="amount">{money(itemsTotal)}</strong></p>
            {fieldError('items')}
            <label className="field">
              <span className="field__label">{t('editor.paid.label')}</span>
              <input
                inputMode="decimal"
                value={draft.amount}
                placeholder={itemsTotal > 0 ? centsToText(itemsTotal) : undefined}
                onChange={e => set('amount', e.target.value)}
                autoComplete="off"
              />
            </label>
            <p className="group__hint" aria-live="polite">
              {paidDifference !== 0
                ? t('editor.paid.difference', { amount: signedMoney(money, paidDifference) })
                : t('editor.paid.hint')}
            </p>
            {fieldError('amount')}
            {paidDifference !== 0 && (
              <div className="bill-summary">
                {pays.length > 0 ? (
                  <PaysList rows={pays} label={t('claim.paysTitle')} money={money} />
                ) : (
                  <p className="note">{t('claim.paysWaiting')}</p>
                )}
              </div>
            )}
          </fieldset>
        )}

        {reviewing && (
          <button type="button" className="primary" onClick={() => { setOcrState('idle'); setOcrMessage('') }}>
            <CheckIcon />{t('editor.scan.confirm')}
          </button>
        )}

        {serverError && <p role="alert" className="form-error">{serverError}</p>}
        {!reviewing && (
          <button type="submit" className="primary" disabled={busy || (itemized && ocrState === 'recognizing')}>{busy ? t('editor.saving') : t('editor.save')}</button>
        )}
        {editing && (
          <button type="button" className="danger" disabled={busy || !online} onClick={() => setConfirmingDelete(true)}>
            <TrashIcon />{t('editor.delete')}
          </button>
        )}
      </form>
      {confirmingDelete && (
        <ConfirmDialog
          title={t('editor.deleteTitle')}
          confirmLabel={t('editor.deleteConfirm')}
          busy={busy}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void deleteExpense()}
        >
          <p>{t('editor.deleteBody', { description: saved?.description ?? '' })}</p>
        </ConfirmDialog>
      )}
    </main>
  )
}
