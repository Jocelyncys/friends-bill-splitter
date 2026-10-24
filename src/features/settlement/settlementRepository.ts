import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import { compareIds } from '../../domain/allocation'
import type { PayerAllocation, Total } from '../../domain/settlement'
import type { EventRole } from '../../domain/types'

// Settlement RPC + reads from migration 202610240008. Reads are RLS selects; the
// snapshot is written only by confirm_settlement. Money is integer cents.

export type SettlementMethod = 'original_payers' | 'optimized_direct' | 'coordinator'
export type PaymentState = 'pending' | 'sent' | 'confirmed' // 'confirmed' = received

// The settlement/payment RPCs raise SQLSTATE 22023 with one of these message keys.
const ERROR_KEYS = [
  'not_allowed',
  'event_not_open',
  'already_settled',
  'invalid_payload',
  'coordinator_required',
  'coordinator_not_creditor',
  'no_expenses',
  'unresolved_expenses',
  'transfer_not_found',
  'event_not_settled',
  'invalid_transition',
  'invalid_reason',
] as const

export type SettlementErrorCode =
  | (typeof ERROR_KEYS)[number]
  | 'stale_revision'
  | 'not_authenticated'
  | 'invalid_payment_details'
  | 'action_failed'

export class SettlementError extends Error {
  readonly code: SettlementErrorCode
  constructor(code: SettlementErrorCode, cause?: unknown) {
    super(code, { cause })
    this.name = 'SettlementError'
    this.code = code
  }
}

export function toSettlementErrorCode(error: { code?: string; message?: string }): SettlementErrorCode {
  if (error.code === '22023' && (ERROR_KEYS as readonly string[]).includes(error.message ?? '')) {
    return error.message as SettlementErrorCode
  }
  if (error.code === '40001' && error.message === 'stale_revision') return 'stale_revision'
  if (error.code === '28000') return 'not_authenticated'
  if (error.code === '23514') return 'invalid_payment_details' // payment_details check constraints
  return 'action_failed'
}

export type SettlementMember = { userId: string; displayName: string; role: EventRole }

export type SettlementInputs = {
  revision: number // pass back as expectedRevision
  members: SettlementMember[]
  totals: Total[] // everyone who paid or shares in an expense, by id
  payerAllocations: PayerAllocation[]
  unresolved: Array<{ expenseId: string; description: string; unallocatedCents: number }>
}

export type SettlementBalance = { userId: string; paidCents: number; owedCents: number; netCents: number }
export type SettlementTransfer = {
  id: string
  payerId: string
  receiverId: string
  amountCents: number
  state: PaymentState
  updatedAt: string
}
export type Settlement = {
  id: string
  method: SettlementMethod
  coordinatorId: string | null
  confirmedBy: string
  confirmedAt: string
  balances: SettlementBalance[]
  transfers: SettlementTransfer[] // generation order; only those RLS lets the caller see
}

type ExpenseRow = {
  id: string
  description: string
  payer_user_id: string
  total_cents: number
  allocations: Array<{ participant_user_id: string; amount_cents: number }>
}

type SettlementRow = {
  id: string
  method: SettlementMethod
  coordinator_user_id: string | null
  confirmed_by: string
  confirmed_at: string
  settlement_balances: Array<{ user_id: string; paid_cents: number; owed_cents: number; net_cents: number }>
  settlement_transfers: Array<{
    id: string
    payer_user_id: string
    receiver_user_id: string
    amount_cents: number
    state: PaymentState
    updated_at: string
    ordinal: number
  }>
}

function check(error: unknown): void {
  if (error) throw new SettlementError('action_failed', error)
}

export function createSettlementRepository(client: SupabaseClient = supabase) {
  return {
    // Same inputs the server recomputes from, for the client-side preview (Task 8 functions).
    async getSettlementInputs(eventId: string): Promise<SettlementInputs> {
      // Revision FIRST: data read afterwards is at least as new, so a stale preview
      // can never carry a fresh revision past confirm_settlement's guard.
      const event = await client.from('events').select('revision').eq('id', eventId).single()
      check(event.error)
      const [members, expenses] = await Promise.all([
        client.from('event_members').select('user_id, display_name, role').eq('event_id', eventId).order('joined_at'),
        client
          .from('expenses')
          .select('id, description, payer_user_id, total_cents, allocations(participant_user_id, amount_cents)')
          .eq('event_id', eventId)
          .order('created_at'),
      ])
      check(members.error)
      check(expenses.error)

      const totals = new Map<string, Total>()
      const totalFor = (userId: string) => {
        let total = totals.get(userId)
        if (!total) totals.set(userId, (total = { userId, paidCents: 0, owedCents: 0 }))
        return total
      }
      const payerAllocations: PayerAllocation[] = []
      const unresolved: SettlementInputs['unresolved'] = []
      for (const x of expenses.data as unknown as ExpenseRow[]) {
        totalFor(x.payer_user_id).paidCents += x.total_cents
        let allocated = 0
        for (const a of x.allocations) {
          totalFor(a.participant_user_id).owedCents += a.amount_cents
          allocated += a.amount_cents
          payerAllocations.push({ expenseId: x.id, payerId: x.payer_user_id, participantId: a.participant_user_id, amountCents: a.amount_cents })
        }
        if (allocated !== x.total_cents) {
          unresolved.push({ expenseId: x.id, description: x.description, unallocatedCents: x.total_cents - allocated })
        }
      }

      return {
        revision: (event.data as { revision: number }).revision,
        members: (members.data as Array<{ user_id: string; display_name: string; role: EventRole }>).map(m => ({
          userId: m.user_id,
          displayName: m.display_name,
          role: m.role,
        })),
        totals: [...totals.values()].sort((a, b) => compareIds(a.userId, b.userId)),
        payerAllocations,
        unresolved,
      }
    },

    async confirmSettlement(input: {
      eventId: string
      method: SettlementMethod
      coordinatorId?: string | null
      expectedRevision: number
    }): Promise<string> {
      const { data, error } = await client.rpc('confirm_settlement', {
        event_id: input.eventId,
        method: input.method,
        coordinator_id: input.coordinatorId ?? null,
        expected_revision: input.expectedRevision,
      })
      if (error) throw new SettlementError(toSettlementErrorCode(error), error)
      return data as string
    },

    // null until the event is settled.
    async getSettlement(eventId: string): Promise<Settlement | null> {
      const { data, error } = await client
        .from('settlements')
        .select(
          'id, method, coordinator_user_id, confirmed_by, confirmed_at, ' +
            'settlement_balances(user_id, paid_cents, owed_cents, net_cents), ' +
            'settlement_transfers(id, payer_user_id, receiver_user_id, amount_cents, state, updated_at, ordinal)',
        )
        .eq('event_id', eventId)
        .maybeSingle()
      check(error)
      if (!data) return null
      const row = data as unknown as SettlementRow
      return {
        id: row.id,
        method: row.method,
        coordinatorId: row.coordinator_user_id,
        confirmedBy: row.confirmed_by,
        confirmedAt: row.confirmed_at,
        balances: row.settlement_balances
          .map(b => ({ userId: b.user_id, paidCents: b.paid_cents, owedCents: b.owed_cents, netCents: b.net_cents }))
          .sort((a, b) => compareIds(a.userId, b.userId)),
        transfers: [...row.settlement_transfers]
          .sort((a, b) => a.ordinal - b.ordinal)
          .map(t => ({
            id: t.id,
            payerId: t.payer_user_id,
            receiverId: t.receiver_user_id,
            amountCents: t.amount_cents,
            state: t.state,
            updatedAt: t.updated_at,
          })),
      }
    },
  }
}
