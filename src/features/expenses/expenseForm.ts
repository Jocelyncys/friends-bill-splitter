import { z } from 'zod'
import { allocateEqual, validateCustomAllocation } from '../../domain/allocation'
import type { SaveExpensePayload } from './expenseRepository'

// ---- money text <-> integer cents (string parsing only, never float math) ----

const MONEY_RE = /^(\d+)(?:\.(\d{1,2}))?$/

/** "12" | "12.5" | "12.50" -> cents. Anything else (>2 decimals, zero, negative, junk) -> null. */
export function parseMoneyToCents(text: string): number | null {
  const match = MONEY_RE.exec(text.trim())
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) && cents >= 1 ? cents : null
}

// ---- draft (what the inputs hold: strings) ----

export type DraftSplitMethod = 'equal' | 'custom' | 'items' | 'host_assignment'

export type DraftItem = { id: string; description: string; price: string; assigneeId: string }

export type ExpenseDraft = {
  description: string
  amount: string
  payerUserId: string
  expenseDate: string
  splitMethod: DraftSplitMethod
  participantIds: string[]
  shares: Record<string, string>
  items: DraftItem[]
}

export type FormErrors = Partial<Record<'description' | 'amount' | 'payer' | 'date' | 'participants' | 'shares' | 'items', string>>

// ---- validated values (cents) ----

const id = z.string().min(1)
const cents = z.number().int().min(1)

const common = {
  description: z.string().trim().min(1),
  payerUserId: id,
  expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}

const rowItem = z.object({ id, description: z.string().trim().min(1), priceCents: cents })

export const expenseFormSchema = z.discriminatedUnion('splitMethod', [
  z.object({ ...common, splitMethod: z.literal('items'), items: z.array(rowItem).min(1) }),
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
    items: z.array(rowItem.extend({ assigneeId: id })).min(1),
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
    raw = { ...draft, items }
  } else {
    const totalCents = parseMoneyToCents(draft.amount)
    if (totalCents === null) errors.amount = 'amount_invalid'
    const shares =
      draft.splitMethod === 'custom'
        ? Object.entries(draft.shares)
            .filter(([, text]) => text.trim() !== '')
            .map(([userId, text]) => ({ userId, cents: parseMoneyToCents(text) }))
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
  const allocated = Object.values(shareTexts).reduce((sum, text) => sum + (parseMoneyToCents(text) ?? 0), 0)
  return total - allocated
}

// ---- values -> RPC payload ----

export function buildPayload(ctx: { id: string; eventId: string }, values: ExpenseFormValues): SaveExpensePayload {
  const head = {
    id: ctx.id,
    eventId: ctx.eventId,
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
      const totalCents = items.reduce((sum, item) => sum + item.totalCents, 0)
      if (values.splitMethod === 'items') return { ...head, totalCents, splitMethod: 'item_claim', items, allocations: [] }
      return {
        ...head,
        totalCents,
        splitMethod: 'host_assignment',
        items,
        allocations: values.items.map(item => ({ itemId: item.id, participantUserId: item.assigneeId, amountCents: item.priceCents })),
      }
    }
  }
}
