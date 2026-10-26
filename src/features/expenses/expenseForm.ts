import { z } from 'zod'
import { allocateEqual, validateCustomAllocation } from '../../domain/allocation'
import type { SaveExpensePayload } from './expenseRepository'

// ---- money text <-> integer cents (string parsing only, never float math) ----

const MONEY_RE = /^(\d+)(?:\.(\d{1,2}))?$/

/**
 * "12" | "12.5" | "12.50" -> cents. Anything else (>2 decimals, zero, negative, junk) -> null.
 * `allowZero` accepts "0" / "0.00" (a custom share for someone who owes nothing).
 */
export function parseMoneyToCents(text: string, { allowZero = false }: { allowZero?: boolean } = {}): number | null {
  const match = MONEY_RE.exec(text.trim())
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents >= (allowZero ? 0 : 1) ? cents : null
}

/** integer cents -> "12.50" without float maths */
export const centsToText = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`

// ---- draft (what the inputs hold: strings) ----

export type DraftSplitMethod = 'equal' | 'custom' | 'items' | 'host_assignment'

/** assigneeIds: the people who had the item; it is split equally between them. */
export type DraftItem = { id: string; description: string; price: string; assigneeIds: string[] }

/**
 * Each person's items subtotal (shared items split with allocateEqual), or null while any item has no valid
 * price or nobody assigned. Feeds owedShares for the live "pays" preview.
 */
export function itemCentsByPerson(items: DraftItem[]): Record<string, number> | null {
  const totals: Record<string, number> = {}
  for (const item of items) {
    const cents = parseMoneyToCents(item.price)
    if (cents === null || item.assigneeIds.length === 0) return null
    for (const [userId, share] of Object.entries(allocateEqual(cents, item.assigneeIds))) totals[userId] = (totals[userId] ?? 0) + share
  }
  return totals
}

export type ExpenseDraft = {
  description: string
  /**
   * Equal / custom: the total. Itemized: the optional "Amount paid" (after vouchers, tax and rounding);
   * empty means the items total. Sharing one field means switching method keeps what was typed.
   */
  amount: string
  payerUserId: string
  expenseDate: string
  splitMethod: DraftSplitMethod
  participantIds: string[]
  shares: Record<string, string>
  items: DraftItem[]
}

export type FormErrors = Partial<
  Record<'description' | 'amount' | 'payer' | 'date' | 'participants' | 'shares' | 'items', string>
>

// ---- validated values (cents) ----

const id = z.string().min(1)
const cents = z.number().int().min(1)

const common = {
  description: z.string().trim().min(1),
  payerUserId: id,
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}

const rowItem = z.object({ id, description: z.string().trim().min(1), priceCents: cents })
// Itemized (claim) items may carry an existing assignment (one or more people) from the saved expense.
const claimItem = rowItem.extend({ assigneeIds: z.array(id) })
// Itemized: what was paid, when it differs from the items total (null = same as the items).
const paidCents = cents.nullable()

export const expenseFormSchema = z.discriminatedUnion('splitMethod', [
  z.object({ ...common, splitMethod: z.literal('items'), items: z.array(claimItem).min(1), paidCents }),
  z.object({ ...common, splitMethod: z.literal('equal'), totalCents: cents, participantIds: z.array(id).min(1) }),
  z
    .object({
      ...common,
      splitMethod: z.literal('custom'),
      totalCents: cents,
      shares: z.array(z.object({ userId: id, cents: z.number().int().min(0) })),
    })
    .refine(v => validateCustomAllocation(v.totalCents, Object.fromEntries(v.shares.map(s => [s.userId, s.cents]))).valid, {
      path: ['shares'],
    }),
  z.object({
    ...common,
    splitMethod: z.literal('host_assignment'),
    items: z.array(rowItem.extend({ assigneeIds: z.array(id).min(1) })).min(1),
    paidCents,
  }),
])

export type ExpenseFormValues = z.infer<typeof expenseFormSchema>

const ERROR_BY_FIELD: Record<string, [keyof FormErrors, string]> = {
  description: ['description', 'description_required'],
  payerUserId: ['payer', 'payer_required'],
  expenseDate: ['date', 'date_invalid'],
  totalCents: ['amount', 'amount_invalid'],
  participantIds: ['participants', 'participants_required'],
  shares: ['shares', 'shares_mismatch'],
  items: ['items', 'items_invalid'],
}

/** Converts every displayed decimal to cents at the boundary, then validates the structure. */
export function validateDraft(draft: ExpenseDraft): { ok: true; values: ExpenseFormValues } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {}
  let raw: unknown
  if (draft.splitMethod === 'items' || draft.splitMethod === 'host_assignment') {
    const items = draft.items.map(item => ({ ...item, priceCents: parseMoneyToCents(item.price) }))
    if (items.some(item => item.priceCents === null)) errors.items = 'items_invalid'
    // "Amount paid" is optional (empty = the items total) and at least 0.01. Item prices are at least 0.01 too,
    // so save_expense's adjustments_need_items cannot happen from this form.
    const paidCents = draft.amount.trim() === '' ? null : parseMoneyToCents(draft.amount)
    if (draft.amount.trim() !== '' && paidCents === null) errors.amount = 'amount_invalid'
    raw = { ...draft, items, paidCents }
  } else {
    const totalCents = parseMoneyToCents(draft.amount)
    if (totalCents === null) errors.amount = 'amount_invalid'
    const shares =
      draft.splitMethod === 'custom'
        ? Object.entries(draft.shares)
            .filter(([, text]) => text.trim() !== '')
            .map(([userId, text]) => ({ userId, cents: parseMoneyToCents(text, { allowZero: true }) }))
        : []
    if (shares.some(s => s.cents === null)) errors.shares = 'shares_mismatch'
    raw = { ...draft, totalCents, shares }
  }
  const parsed = expenseFormSchema.safeParse(raw)
  if (parsed.success && Object.keys(errors).length === 0) return { ok: true, values: parsed.data }
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const mapped = ERROR_BY_FIELD[String(issue.path[0])]
      if (mapped) errors[mapped[0]] ??= mapped[1]
    }
  }
  return { ok: false, errors }
}

/** Live "remaining" for custom split: total minus the valid share inputs, in cents. */
export function customDifference(amountText: string, shareTexts: Record<string, string>): number {
  const total = parseMoneyToCents(amountText) ?? 0
  const allocated = Object.values(shareTexts).reduce((sum, text) => sum + (parseMoneyToCents(text, { allowZero: true }) ?? 0), 0)
  return total - allocated
}

// ---- values -> RPC payload ----

export function buildPayload(ctx: { id: string; eventId: string; category?: string }, values: ExpenseFormValues): SaveExpensePayload {
  const head = {
    id: ctx.id,
    eventId: ctx.eventId,
    ...(ctx.category ? { category: ctx.category } : {}),
    payerUserId: values.payerUserId,
    description: values.description,
    expenseDate: values.expenseDate,
  }
  switch (values.splitMethod) {
    case 'equal':
      return {
        ...head,
        totalCents: values.totalCents,
        splitMethod: 'equal',
        items: [],
        allocations: Object.entries(allocateEqual(values.totalCents, values.participantIds)).map(([participantUserId, amountCents]) => ({
          itemId: null,
          participantUserId,
          amountCents,
        })),
      }
    case 'custom':
      return {
        ...head,
        totalCents: values.totalCents,
        splitMethod: 'custom',
        items: [],
        allocations: values.shares
          .filter(s => s.cents > 0)
          .map(s => ({ itemId: null, participantUserId: s.userId, amountCents: s.cents })),
      }
    case 'items':
    case 'host_assignment': {
      const items = values.items.map((item, sortOrder) => ({
        id: item.id,
        description: item.description,
        quantity: 1,
        totalCents: item.priceCents,
        sortOrder,
      }))
      // A different amount paid becomes ONE unlabelled 'other' adjustment (paid - items), so the total is what was
      // paid. Its id is the expense id: one per expense, stable across retries and re-saves.
      const itemsCents = items.reduce((sum, item) => sum + item.totalCents, 0)
      const paid = values.paidCents ?? itemsCents
      const adjustments =
        paid === itemsCents ? [] : [{ id: ctx.id, kind: 'other' as const, label: null, amountCents: paid - itemsCents, sortOrder: 0 }]
      const totalCents = paid
      // One allocation per assignee: the equal split of the item (save_expense checks the same rule).
      // Items with self-claims never carry assignees here (the server keeps their claims).
      const allocations = values.items.flatMap(item =>
        item.assigneeIds.length === 0
          ? []
          : Object.entries(allocateEqual(item.priceCents, item.assigneeIds)).map(([participantUserId, amountCents]) => ({
              itemId: item.id,
              participantUserId,
              amountCents,
            })),
      )
      return {
        ...head,
        totalCents,
        splitMethod: values.splitMethod === 'items' ? 'item_claim' : 'host_assignment',
        items,
        allocations,
        adjustments,
      }
    }
  }
}

/** Inverse of buildPayload: refills the form from a saved payload, keeping the same ids. */
export function draftFromPayload(payload: SaveExpensePayload): ExpenseDraft {
  const base = { description: payload.description, payerUserId: payload.payerUserId, expenseDate: payload.expenseDate }
  const ids = payload.allocations.map(a => a.participantUserId)
  if (payload.splitMethod === 'item_claim' || payload.splitMethod === 'host_assignment') {
    return {
      ...base,
      // With adjustments (one, or several from older versions) the total is the amount paid.
      amount: (payload.adjustments ?? []).length > 0 ? centsToText(payload.totalCents) : '',
      splitMethod: payload.splitMethod === 'item_claim' ? 'items' : 'host_assignment',
      participantIds: [],
      shares: {},
      items: payload.items.map(item => ({
        id: item.id,
        description: item.description,
        price: centsToText(item.totalCents),
        assigneeIds: payload.allocations.filter(a => a.itemId === item.id).map(a => a.participantUserId),
      })),
    }
  }
  return {
    ...base,
    amount: centsToText(payload.totalCents),
    splitMethod: payload.splitMethod,
    participantIds: payload.splitMethod === 'equal' ? ids : [],
    shares: payload.splitMethod === 'custom' ? Object.fromEntries(payload.allocations.map(a => [a.participantUserId, centsToText(a.amountCents)])) : {},
    items: [{ id: crypto.randomUUID(), description: '', price: '', assigneeIds: [] }],
  }
}
