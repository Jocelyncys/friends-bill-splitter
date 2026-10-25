import { z } from 'zod'
import { allocateEqual, validateCustomAllocation } from '../../domain/allocation'
import type { AdjustmentKind, SaveExpensePayload } from './expenseRepository'

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

/** A bill-level line as typed: an unsigned amount plus a sign (discount minus, tax and service plus). */
export type DraftAdjustment = { id: string; kind: AdjustmentKind; label: string; amount: string; sign: 1 | -1 }

export const ADJUSTMENT_KINDS: AdjustmentKind[] = ['discount', 'tax', 'service', 'rounding', 'other']

/** Discount always takes money off, tax and service charge always add; rounding and other keep the chosen sign. */
export function signForKind(kind: AdjustmentKind, current: 1 | -1): 1 | -1 {
  if (kind === 'discount') return -1
  if (kind === 'tax' || kind === 'service') return 1
  return current
}

export const hasSignChoice = (kind: AdjustmentKind) => kind === 'rounding' || kind === 'other'

const adjustmentCents = (a: DraftAdjustment): number | null => {
  const cents = parseMoneyToCents(a.amount)
  return cents === null ? null : signForKind(a.kind, a.sign) * cents
}

/** Sum of the valid adjustment rows in signed cents (live display). */
export function adjustmentsCents(adjustments: DraftAdjustment[] | undefined): number {
  return (adjustments ?? []).reduce((sum, a) => sum + (adjustmentCents(a) ?? 0), 0)
}

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
  amount: string
  payerUserId: string
  expenseDate: string
  splitMethod: DraftSplitMethod
  participantIds: string[]
  shares: Record<string, string>
  items: DraftItem[]
  // Bill-level adjustments (voucher, SST, service charge, rounding) of an itemized expense.
  adjustments?: DraftAdjustment[]
}

export type FormErrors = Partial<
  Record<'description' | 'amount' | 'payer' | 'date' | 'participants' | 'shares' | 'items' | 'adjustments', string>
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
const adjustment = z.object({
  id,
  kind: z.enum(['discount', 'tax', 'service', 'rounding', 'other']),
  label: z.string().trim().min(1).max(60),
  amountCents: z.number().int().refine(v => v !== 0),
  sortOrder: z.number().int(),
})
const adjustments = z.array(adjustment).default([])

export const expenseFormSchema = z.discriminatedUnion('splitMethod', [
  z.object({ ...common, splitMethod: z.literal('items'), items: z.array(claimItem).min(1), adjustments }),
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
    adjustments,
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
    // Mirrors save_expense: invalid_adjustment (label 1-60, non-zero amount), adjustments_need_items,
    // and a paid total of at least one cent (adjustments_total; the server would say invalid_total).
    const adjustments = (draft.adjustments ?? []).map((a, sortOrder) => ({
      id: a.id,
      kind: a.kind,
      label: a.label.trim(),
      amountCents: adjustmentCents(a),
      sortOrder,
    }))
    const itemsCents = items.reduce((sum, item) => sum + (item.priceCents ?? 0), 0)
    if (adjustments.some(a => a.amountCents === null || a.label.length < 1 || a.label.length > 60)) {
      errors.adjustments = 'invalid_adjustment'
    } else if (adjustments.length > 0 && !errors.items) {
      if (itemsCents <= 0) errors.adjustments = 'adjustments_need_items'
      else if (itemsCents + adjustments.reduce((sum, a) => sum + (a.amountCents ?? 0), 0) < 1) errors.adjustments = 'adjustments_total'
    }
    raw = { ...draft, items, adjustments }
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
      // Paid total = items + bill-level adjustments (save_expense checks the same rule).
      const adjustments = values.adjustments
      const totalCents =
        items.reduce((sum, item) => sum + item.totalCents, 0) + adjustments.reduce((sum, a) => sum + a.amountCents, 0)
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
      amount: '',
      splitMethod: payload.splitMethod === 'item_claim' ? 'items' : 'host_assignment',
      participantIds: [],
      shares: {},
      items: payload.items.map(item => ({
        id: item.id,
        description: item.description,
        price: centsToText(item.totalCents),
        assigneeIds: payload.allocations.filter(a => a.itemId === item.id).map(a => a.participantUserId),
      })),
      adjustments: (payload.adjustments ?? []).map(a => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        amount: centsToText(Math.abs(a.amountCents)),
        sign: a.amountCents < 0 ? -1 : 1,
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
