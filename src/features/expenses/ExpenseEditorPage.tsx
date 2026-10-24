import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'
import { formatMoney } from '../../domain/money'
import type { EventHome } from '../events/eventRepository'
import { EventStatus } from '../events/EventStatus'
import { useEventHome } from '../events/useEventHome'
import {
  buildPayload,
  customDifference,
  parseMoneyToCents,
  validateDraft,
  type DraftItem,
  type DraftSplitMethod,
  type ExpenseDraft,
  type FormErrors,
} from './expenseForm'
import { createExpenseRepository, ExpenseSaveError } from './expenseRepository'

const METHODS: DraftSplitMethod[] = ['equal', 'custom', 'items', 'host_assignment']

function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const blankItem = (): DraftItem => ({ id: crypto.randomUUID(), description: '', price: '', assigneeId: '' })

export function ExpenseEditorPage() {
  const { eventId = '' } = useParams()
  const state = useEventHome(eventId)
  if (state.status !== 'ready') return <EventStatus state={state} />
  return <EditorForm home={state.home} />
}

function EditorForm({ home }: { home: EventHome }) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const eventId = home.event.id
  const [expenseId] = useState(() => crypto.randomUUID())
  const [draft, setDraft] = useState<ExpenseDraft>(() => ({
    description: '',
    amount: '',
    payerUserId: home.me.userId,
    expenseDate: today(),
    splitMethod: 'equal',
    participantIds: home.members.map(m => m.userId),
    shares: {},
    items: [blankItem()],
  }))
  const [errors, setErrors] = useState<FormErrors>({})
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const set = <K extends keyof ExpenseDraft>(key: K, value: ExpenseDraft[K]) => setDraft(d => ({ ...d, [key]: value }))
  const setItem = (index: number, patch: Partial<DraftItem>) =>
    set('items', draft.items.map((item, i) => (i === index ? { ...item, ...patch } : item)))
  const money = (cents: number) => formatMoney(cents, home.event.currency, i18n.language)
  const fieldError = (key: keyof FormErrors) => (errors[key] ? <p className="field-error">{t(`editor.errors.${errors[key]}`)}</p> : null)

  const canPickPayer = home.me.role !== 'participant'
  const itemized = draft.splitMethod === 'items' || draft.splitMethod === 'host_assignment'
  const itemsTotal = draft.items.reduce((sum, item) => sum + (parseMoneyToCents(item.price) ?? 0), 0)
  const difference = customDifference(draft.amount, draft.shares)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setServerError(null)
    const result = validateDraft(draft)
    if (!result.ok) return setErrors(result.errors)
    setErrors({})
    setBusy(true)
    try {
      await createExpenseRepository().saveExpense(buildPayload({ id: expenseId, eventId }, result.values))
      navigate(`/event/${eventId}`)
    } catch (err) {
      const code = err instanceof ExpenseSaveError ? err.formError.code : 'save_failed'
      setServerError(t(`expenseError.${code}`, { defaultValue: t('expenseError.save_failed') }))
      setBusy(false)
    }
  }

  return (
    <main>
      <h1>{t('editor.title')}</h1>
      <form className="form" onSubmit={e => void submit(e)} noValidate>
        <label>
          {t('editor.description')}
          <input value={draft.description} onChange={e => set('description', e.target.value)} autoComplete="off" />
        </label>
        {fieldError('description')}

        {!itemized && (
          <>
            <label>
              {t('editor.amount')}
              <input inputMode="decimal" value={draft.amount} onChange={e => set('amount', e.target.value)} autoComplete="off" />
            </label>
            {fieldError('amount')}
          </>
        )}

        {canPickPayer ? (
          <label>
            {t('editor.payer')}
            <select value={draft.payerUserId} onChange={e => set('payerUserId', e.target.value)}>
              {home.members.map(m => (
                <option key={m.userId} value={m.userId}>{m.displayName}</option>
              ))}
            </select>
          </label>
        ) : (
          <p>{t('editor.payer')}: <strong>{home.me.displayName}</strong></p>
        )}
        {fieldError('payer')}

        <label>
          {t('editor.date')}
          <input type="date" value={draft.expenseDate} onChange={e => set('expenseDate', e.target.value)} />
        </label>
        {fieldError('date')}

        <label>
          {t('editor.splitMethod')}
          <select value={draft.splitMethod} onChange={e => set('splitMethod', e.target.value as DraftSplitMethod)}>
            {METHODS.map(m => (
              <option key={m} value={m}>{t(`editor.method.${m}`)}</option>
            ))}
          </select>
        </label>

        {draft.splitMethod === 'equal' && (
          <fieldset>
            <legend>{t('editor.participants')}</legend>
            {home.members.map(m => (
              <label key={m.userId} className="check">
                <input
                  type="checkbox"
                  checked={draft.participantIds.includes(m.userId)}
                  onChange={e =>
                    set('participantIds', e.target.checked ? [...draft.participantIds, m.userId] : draft.participantIds.filter(id => id !== m.userId))
                  }
                />
                {m.displayName}
              </label>
            ))}
            {fieldError('participants')}
          </fieldset>
        )}

        {draft.splitMethod === 'custom' && (
          <fieldset>
            <legend>{t('editor.participants')}</legend>
            {home.members.map(m => (
              <label key={m.userId}>
                {t('editor.shareFor', { name: m.displayName })}
                <input
                  inputMode="decimal"
                  value={draft.shares[m.userId] ?? ''}
                  onChange={e => set('shares', { ...draft.shares, [m.userId]: e.target.value })}
                  autoComplete="off"
                />
              </label>
            ))}
            <p aria-live="polite">{t('editor.remaining', { amount: money(difference) })}</p>
            {fieldError('shares')}
          </fieldset>
        )}

        {itemized && (
          <fieldset>
            <legend>{t('editor.items')}</legend>
            {draft.items.map((item, index) => (
              <div key={item.id} className="item-row">
                <label>
                  {t('editor.itemDescription', { n: index + 1 })}
                  <input value={item.description} onChange={e => setItem(index, { description: e.target.value })} autoComplete="off" />
                </label>
                <label>
                  {t('editor.itemPrice', { n: index + 1 })}
                  <input inputMode="decimal" value={item.price} onChange={e => setItem(index, { price: e.target.value })} autoComplete="off" />
                </label>
                {draft.splitMethod === 'host_assignment' && (
                  <label>
                    {t('editor.itemAssignee', { n: index + 1 })}
                    <select value={item.assigneeId} onChange={e => setItem(index, { assigneeId: e.target.value })}>
                      <option value="">{t('editor.chooseMember')}</option>
                      {home.members.map(m => (
                        <option key={m.userId} value={m.userId}>{m.displayName}</option>
                      ))}
                    </select>
                  </label>
                )}
                {draft.items.length > 1 && (
                  <button type="button" onClick={() => set('items', draft.items.filter((_, i) => i !== index))}>
                    {t('editor.removeItem', { n: index + 1 })}
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={() => set('items', [...draft.items, blankItem()])}>{t('editor.addItem')}</button>
            <p>{t('editor.total')}: <strong>{money(itemsTotal)}</strong></p>
            {fieldError('items')}
          </fieldset>
        )}

        {serverError && <p role="alert" className="form-error">{serverError}</p>}
        <button type="submit" className="primary" disabled={busy}>{busy ? t('editor.saving') : t('editor.save')}</button>
      </form>
    </main>
  )
}
