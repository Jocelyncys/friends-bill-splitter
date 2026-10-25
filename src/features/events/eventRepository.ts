import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import type { EventMode, EventRole, EventState } from '../../domain/types'
import { EXPENSE_SUMMARY_COLUMNS, toExpenseSummary, type ExpenseRow, type ExpenseSummary } from '../expenses/expenseRepository'
import { callAction } from '../expenses/claimRepository'

export type CreateEventInput = { name: string; mode: EventMode; currency: 'MYR'; displayName: string }

export type EventMember = { userId: string; displayName: string; role: EventRole }

export type AttentionItem = { kind: 'unclaimed_items'; expenseId: string; description: string; unallocatedCents: number }

export type EventHome = {
  event: { id: string; name: string; mode: EventMode; currency: string; state: EventState; revision: number }
  me: EventMember
  members: EventMember[]
  expenses: ExpenseSummary[] // newest first
  groupTotalCents: number
  attention: AttentionItem[]
}

// `returns table(...)` RPCs come back from supabase-js as an array of rows.
function firstRow<T>(data: T[] | null, fn: string): T {
  const row = data?.[0]
  if (!row) throw new Error(`${fn} returned no rows`)
  return row
}

// The event already exists on the server: a storage failure (quota, disabled storage)
// must never turn that into a reported failure, or the one-time invite token is lost.
function rememberName(name: string) {
  try {
    localStorage.setItem('preferredName', name)
  } catch {
    // only a convenience for the next form
  }
}

export function createEventRepository(client: SupabaseClient = supabase) {
  return {
    async createEvent(input: CreateEventInput) {
      const displayName = input.displayName.trim()
      const { data, error } = await client.rpc('create_event', {
        name: input.name,
        mode: input.mode,
        currency: input.currency,
        display_name: displayName,
      })
      if (error) throw error
      const row = firstRow<{ event_id: string; invite_token: string }>(data, 'create_event')
      rememberName(displayName)
      return { eventId: row.event_id, inviteToken: row.invite_token }
    },
    async joinEvent(inviteToken: string, displayName: string) {
      const name = displayName.trim()
      const { data, error } = await client.rpc('join_event', { invite_token: inviteToken, display_name: name })
      if (error) throw error
      const row = firstRow<{ event_id: string }>(data, 'join_event')
      rememberName(name)
      return row.event_id
    },
    // Owner only, participant <-> cohost; failures throw ActionError.
    setMemberRole: (eventId: string, memberId: string, role: Exclude<EventRole, 'owner'>) =>
      callAction(client, 'set_member_role', { event_id: eventId, member_id: memberId, role }),
    // Plain RLS-protected reads; a non-member gets no rows.
    async getEventHome(eventId: string): Promise<EventHome> {
      const [session, eventResult, membersResult, expensesResult] = await Promise.all([
        client.auth.getSession(),
        client.from('events').select('id, name, mode, currency, state, revision').eq('id', eventId).maybeSingle(),
        client.from('event_members').select('user_id, display_name, role').eq('event_id', eventId).order('joined_at'),
        client
          .from('expenses')
          .select(`${EXPENSE_SUMMARY_COLUMNS}, allocations(amount_cents), expense_adjustments(amount_cents)`)
          .eq('event_id', eventId)
          .order('created_at', { ascending: false }),
      ])
      // RLS returns no event row to a non-member (PGRST116 if a single row was required).
      if (eventResult.error?.code === 'PGRST116' || (!eventResult.error && !eventResult.data)) throw new Error('not_member')
      for (const result of [eventResult, membersResult, expensesResult]) if (result.error) throw result.error

      const members = (membersResult.data as Array<{ user_id: string; display_name: string; role: EventRole }>).map(m => ({
        userId: m.user_id,
        displayName: m.display_name,
        role: m.role,
      }))
      const me = members.find(m => m.userId === session.data.session?.user.id)
      if (!me) throw new Error('not_member')

      const rows = expensesResult.data as Array<
        ExpenseRow & { allocations: Array<{ amount_cents: number }>; expense_adjustments?: Array<{ amount_cents: number }> }
      >
      const attention: AttentionItem[] = []
      for (const row of rows) {
        if (row.split_method !== 'item_claim' && row.split_method !== 'host_assignment') continue
        // Allocations cover the items subtotal: the paid total minus bill-level adjustments.
        const allocated = row.allocations.reduce((sum, a) => sum + a.amount_cents, 0)
        const subtotal = row.total_cents - (row.expense_adjustments ?? []).reduce((sum, a) => sum + a.amount_cents, 0)
        if (allocated < subtotal) {
          attention.push({ kind: 'unclaimed_items', expenseId: row.id, description: row.description, unallocatedCents: subtotal - allocated })
        }
      }

      return {
        event: eventResult.data as EventHome['event'],
        me,
        members,
        expenses: rows.map(toExpenseSummary),
        groupTotalCents: rows.reduce((sum, row) => sum + row.total_cents, 0),
        attention,
      }
    },
  }
}
