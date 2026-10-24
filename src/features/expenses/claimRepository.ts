import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import type { SplitMethod } from '../../domain/types'

// Claim / assignment / close-claiming RPCs from migration 202610240006. Writes go
// only through these RPCs; reads are plain RLS selects. Money is integer cents.

export type AllocationSource = 'self_claim' | 'expense_creator' | 'cohost' | 'owner' | 'calculated'

export type ClaimItem = { id: string; description: string; quantity: number; totalCents: number; sortOrder: number }

export type ClaimAllocation = {
  id: string
  itemId: string | null
  participantUserId: string
  amountCents: number
  source: AllocationSource
}

export type ExpenseClaims = {
  id: string
  eventId: string
  creatorUserId: string
  description: string
  totalCents: number
  splitMethod: SplitMethod
  claimingClosed: boolean
  items: ClaimItem[] // by sortOrder
  allocations: ClaimAllocation[]
}

// The RPCs raise SQLSTATE 22023 with one of these message keys.
const ACTION_ERROR_CODES = [
  'item_not_found',
  'event_not_open',
  'not_claimable',
  'claiming_closed',
  'not_allowed',
  'not_member',
  'invalid_role_change',
  'invalid_payload',
] as const

export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number] | 'not_authenticated' | 'expense_not_found' | 'action_failed'

export class ActionError extends Error {
  readonly code: ActionErrorCode
  constructor(code: ActionErrorCode, cause?: unknown) {
    super(code, { cause })
    this.name = 'ActionError'
    this.code = code
  }
}

export function toActionErrorCode(error: { code?: string; message?: string }): ActionErrorCode {
  if (error.code === '22023' && (ACTION_ERROR_CODES as readonly string[]).includes(error.message ?? '')) {
    return error.message as ActionErrorCode
  }
  if (error.code === '28000') return 'not_authenticated'
  return 'action_failed'
}

// Shared by the role RPC in eventRepository.
export async function callAction(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<void> {
  const { error } = await client.rpc(fn, args)
  if (error) throw new ActionError(toActionErrorCode(error), error)
}

type ExpenseClaimsRow = {
  id: string
  event_id: string
  creator_user_id: string
  description: string
  total_cents: number
  split_method: SplitMethod
  claiming_closed: boolean
  expense_items: Array<{ id: string; description: string; quantity: number; total_cents: number; sort_order: number }>
  allocations: Array<{ id: string; item_id: string | null; participant_user_id: string; amount_cents: number; source: AllocationSource }>
}

export function createClaimRepository(client: SupabaseClient = supabase) {
  return {
    claimItem: (itemId: string) => callAction(client, 'claim_item', { item_id: itemId }),
    unclaimItem: (itemId: string) => callAction(client, 'unclaim_item', { item_id: itemId }),
    assignItem: (itemId: string, memberId: string) => callAction(client, 'assign_item', { item_id: itemId, member_id: memberId }),
    setClaimingClosed: (expenseId: string, closed: boolean) =>
      callAction(client, 'set_claiming_closed', { expense_id: expenseId, closed }),
    async getExpenseClaims(expenseId: string): Promise<ExpenseClaims> {
      const { data, error } = await client
        .from('expenses')
        .select(
          'id, event_id, creator_user_id, description, total_cents, split_method, claiming_closed, ' +
            'expense_items(id, description, quantity, total_cents, sort_order), ' +
            'allocations(id, item_id, participant_user_id, amount_cents, source)',
        )
        .eq('id', expenseId)
        .maybeSingle()
      if (error) throw new ActionError('action_failed', error)
      if (!data) throw new ActionError('expense_not_found')
      const row = data as unknown as ExpenseClaimsRow
      return {
        id: row.id,
        eventId: row.event_id,
        creatorUserId: row.creator_user_id,
        description: row.description,
        totalCents: row.total_cents,
        splitMethod: row.split_method,
        claimingClosed: row.claiming_closed,
        items: row.expense_items
          .map(i => ({ id: i.id, description: i.description, quantity: i.quantity, totalCents: i.total_cents, sortOrder: i.sort_order }))
          .sort((a, b) => a.sortOrder - b.sortOrder),
        allocations: row.allocations.map(a => ({
          id: a.id,
          itemId: a.item_id,
          participantUserId: a.participant_user_id,
          amountCents: a.amount_cents,
          source: a.source,
        })),
      }
    },
  }
}
