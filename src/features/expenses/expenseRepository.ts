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
}

export type ExpenseSummary = {
  id: string
  description: string
  totalCents: number
  payerUserId: string
  splitMethod: SplitMethod
  createdAt: string
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
  // form-level: invalid_payload, not_event_member, event_not_open, event_mismatch, not_allowed
}

export function toFormError(error: { code?: string; message?: string }): ExpenseFormError {
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
  }
}

export type ExpenseRow = {
  id: string
  description: string
  total_cents: number
  payer_user_id: string
  split_method: SplitMethod
  created_at: string
}

export const EXPENSE_SUMMARY_COLUMNS = 'id, description, total_cents, payer_user_id, split_method, created_at'

export function toExpenseSummary(row: ExpenseRow): ExpenseSummary {
  return {
    id: row.id,
    description: row.description,
    totalCents: row.total_cents,
    payerUserId: row.payer_user_id,
    splitMethod: row.split_method,
    createdAt: row.created_at,
  }
}

export function createExpenseRepository(client: SupabaseClient = supabase) {
  return {
    // The only write path: one RPC, one transaction on the server.
    async saveExpense(payload: SaveExpensePayload): Promise<{ id: string }> {
      const { data, error } = await client.rpc('save_expense', { payload: toRpcPayload(payload) })
      if (error) throw new ExpenseSaveError(toFormError(error), error)
      return { id: data as string }
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
