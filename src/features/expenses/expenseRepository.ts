import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import type { SplitMethod } from '../../domain/types'

// The app works in camelCase; the save_expense RPC takes the snake_case JSON payload
// defined in migration 202610240005. toRpcPayload() is the only place that maps them.
// All money values are integer cents.
export type SaveExpenseItem = {
  id: string
  description: string
  quantity: number
  totalCents: number
  sortOrder: number
}

export type SaveExpenseAllocation = {
  itemId: string | null
  participantUserId: string
  amountCents: number
}

export type AdjustmentKind = 'discount' | 'tax' | 'service' | 'rounding' | 'other'

/**
 * Bill-level line, item methods only. The app sends at most one: { kind: 'other', label: null, amountCents:
 * paid - items } ("Amount paid"). Expenses saved by older versions may hold several labelled rows.
 */
export type SaveExpenseAdjustment = {
  id: string
  kind: AdjustmentKind
  label: string | null // 1-60 chars; null only for 'other'
  amountCents: number // signed, never 0
  sortOrder: number
}

export type SaveExpensePayload = {
  id: string // client-generated UUID, stable across retries
  eventId: string
  payerUserId: string
  description: string
  category?: string // server defaults to 'other'
  expenseDate: string // YYYY-MM-DD
  totalCents: number
  splitMethod: SplitMethod
  items: SaveExpenseItem[]
  allocations: SaveExpenseAllocation[]
  // item_claim / host_assignment only: totalCents = items + adjustments. Missing = none
  // (also for offline drafts saved before adjustments existed).
  adjustments?: SaveExpenseAdjustment[]
}

export type ExpenseSummary = {
  id: string
  description: string
  totalCents: number
  payerUserId: string
  creatorUserId: string
  splitMethod: SplitMethod
  createdAt: string
}

/** A saved expense reopened for editing. */
export type SavedExpense = {
  payload: SaveExpensePayload // allocations exclude self-claims (save_expense keeps those)
  creatorUserId: string
  /** item id -> user ids that self-claimed it; such items must not get allocations on save. */
  claims: Record<string, string[]>
}

export type ExpenseFormError = { field?: keyof SaveExpensePayload; code: string }

export class ExpenseSaveError extends Error {
  readonly formError: ExpenseFormError
  constructor(formError: ExpenseFormError, cause: unknown) {
    super(formError.code, { cause })
    this.name = 'ExpenseSaveError'
    this.formError = formError
  }
}

// save_expense raises SQLSTATE 22023 with one of these message keys.
const FIELD_BY_CODE: Record<string, keyof SaveExpensePayload | undefined> = {
  payer_not_allowed: 'payerUserId',
  payer_not_member: 'payerUserId',
  invalid_description: 'description',
  invalid_category: 'category',
  invalid_date: 'expenseDate',
  invalid_total: 'totalCents',
  invalid_split_method: 'splitMethod',
  invalid_item: 'items',
  duplicate_item_id: 'items',
  items_not_allowed: 'items',
  items_required: 'items',
  item_total_mismatch: 'items',
  invalid_allocation: 'allocations',
  duplicate_allocation: 'allocations',
  not_member: 'allocations',
  allocation_mismatch: 'allocations',
  allocation_exceeds_item: 'allocations',
  invalid_adjustment: 'adjustments',
  adjustments_not_allowed: 'adjustments',
  adjustments_need_items: 'adjustments',
  adjustment_mismatch: 'adjustments',
  // form-level: invalid_payload, not_event_member, event_not_open, event_mismatch, not_allowed
}

// supabase-js reports a failed fetch as { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 }
// (it never throws), and a gateway failure as status 502/503/504. Those are transport problems, not a verdict
// on the expense, so a retry can succeed. Everything else (403/42501, constraints, 500 ...) is `save_failed`.
const TRANSPORT_STATUSES = new Set([0, 502, 503, 504])
const TRANSPORT_MESSAGE = /failed to fetch|networkerror|network request failed|load failed|fetch failed/i

export function isNetworkFailure(error: { message?: string }, status?: number) {
  return (status !== undefined && TRANSPORT_STATUSES.has(status)) || TRANSPORT_MESSAGE.test(error.message ?? '')
}

export function toFormError(error: { code?: string; message?: string }, status?: number): ExpenseFormError {
  if (isNetworkFailure(error, status)) return { code: 'network_error' }
  if (error.code === '22023' && error.message) {
    const field = FIELD_BY_CODE[error.message]
    return field ? { field, code: error.message } : { code: error.message }
  }
  if (error.code === '28000') return { code: 'not_authenticated' }
  return { code: 'save_failed' }
}

function toRpcPayload(p: SaveExpensePayload) {
  return {
    id: p.id,
    event_id: p.eventId,
    payer_user_id: p.payerUserId,
    description: p.description,
    category: p.category,
    expense_date: p.expenseDate,
    total_cents: p.totalCents,
    split_method: p.splitMethod,
    items: p.items.map(i => ({
      id: i.id,
      description: i.description,
      quantity: i.quantity,
      total_cents: i.totalCents,
      sort_order: i.sortOrder,
    })),
    allocations: p.allocations.map(a => ({
      item_id: a.itemId,
      participant_user_id: a.participantUserId,
      amount_cents: a.amountCents,
    })),
    adjustments: (p.adjustments ?? []).map(a => ({
      id: a.id,
      kind: a.kind,
      label: a.label,
      amount_cents: a.amountCents,
      sort_order: a.sortOrder,
    })),
  }
}

export type ExpenseRow = {
  id: string
  description: string
  total_cents: number
  payer_user_id: string
  creator_user_id: string
  split_method: SplitMethod
  created_at: string
}

export const EXPENSE_SUMMARY_COLUMNS = 'id, description, total_cents, payer_user_id, creator_user_id, split_method, created_at'

export function toExpenseSummary(row: ExpenseRow): ExpenseSummary {
  return {
    id: row.id,
    description: row.description,
    totalCents: row.total_cents,
    payerUserId: row.payer_user_id,
    creatorUserId: row.creator_user_id,
    splitMethod: row.split_method,
    createdAt: row.created_at,
  }
}

type SavedExpenseRow = {
  id: string
  event_id: string
  creator_user_id: string
  payer_user_id: string
  description: string
  category: string
  expense_date: string
  total_cents: number
  split_method: SplitMethod
  expense_items: Array<{ id: string; description: string; quantity: number; total_cents: number; sort_order: number }>
  allocations: Array<{ item_id: string | null; participant_user_id: string; amount_cents: number; source: string }>
  expense_adjustments: Array<{ id: string; kind: AdjustmentKind; label: string | null; amount_cents: number; sort_order: number }>
}

const SAVED_EXPENSE_COLUMNS =
  'id, event_id, creator_user_id, payer_user_id, description, category, expense_date, total_cents, split_method, ' +
  'expense_items(id, description, quantity, total_cents, sort_order), allocations(item_id, participant_user_id, amount_cents, source), ' +
  'expense_adjustments(id, kind, label, amount_cents, sort_order)'

export function toSavedExpense(row: SavedExpenseRow): SavedExpense {
  const claims: Record<string, string[]> = {}
  for (const a of row.allocations) {
    if (a.source === 'self_claim' && a.item_id) (claims[a.item_id] ??= []).push(a.participant_user_id)
  }
  for (const ids of Object.values(claims)) ids.sort()
  return {
    creatorUserId: row.creator_user_id,
    claims,
    payload: {
      id: row.id,
      eventId: row.event_id,
      payerUserId: row.payer_user_id,
      description: row.description,
      category: row.category,
      expenseDate: row.expense_date,
      totalCents: row.total_cents,
      splitMethod: row.split_method,
      items: [...row.expense_items]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(i => ({ id: i.id, description: i.description, quantity: i.quantity, totalCents: i.total_cents, sortOrder: i.sort_order })),
      allocations: row.allocations
        .filter(a => a.source !== 'self_claim')
        .map(a => ({ itemId: a.item_id, participantUserId: a.participant_user_id, amountCents: a.amount_cents })),
      adjustments: [...row.expense_adjustments]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map(a => ({ id: a.id, kind: a.kind, label: a.label, amountCents: a.amount_cents, sortOrder: a.sort_order })),
    },
  }
}

export function createExpenseRepository(client: SupabaseClient = supabase) {
  return {
    // The only write path: one RPC, one transaction on the server.
    async saveExpense(payload: SaveExpensePayload): Promise<{ id: string }> {
      const { data, error, status } = await client.rpc('save_expense', { payload: toRpcPayload(payload) })
      if (error) throw new ExpenseSaveError(toFormError(error, status), error)
      return { id: data as string }
    },
    /** RLS-protected read; a non-member (or a deleted expense) gets expense_not_found. */
    async getExpense(expenseId: string): Promise<SavedExpense> {
      const { data, error } = await client.from('expenses').select(SAVED_EXPENSE_COLUMNS).eq('id', expenseId).maybeSingle()
      if (error) throw error
      if (!data) throw new Error('expense_not_found')
      return toSavedExpense(data as unknown as SavedExpenseRow)
    },
    // Creator or owner/co-host, open event only; the server bumps the revision.
    async deleteExpense(expenseId: string): Promise<void> {
      const { error, status } = await client.rpc('delete_expense', { expense_id: expenseId })
      if (error) throw new ExpenseSaveError(toFormError(error, status), error)
    },
    async listExpenses(eventId: string): Promise<ExpenseSummary[]> {
      const { data, error } = await client
        .from('expenses')
        .select(EXPENSE_SUMMARY_COLUMNS)
        .eq('event_id', eventId)
        .order('created_at', { ascending: false })
      if (error) throw error
      return (data as ExpenseRow[]).map(toExpenseSummary)
    },
  }
}
