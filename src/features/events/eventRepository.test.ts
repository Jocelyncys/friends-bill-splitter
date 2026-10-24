import { describe, expect, it, vi } from 'vitest'
import { createEventRepository } from './eventRepository'
import { ActionError } from '../expenses/claimRepository'

type Result = { data: unknown; error: unknown }
type Builder = { select(): Builder; eq(): Builder; order(): Builder; maybeSingle(): Builder; then(resolve: (r: Result) => unknown): Promise<unknown> }
function builder(result: Result): Builder {
  const b: Builder = { select: () => b, eq: () => b, order: () => b, maybeSingle: () => b, then: resolve => Promise.resolve(result).then(resolve) }
  return b
}

describe('eventRepository', () => {
  it('creates a trip using MYR, passes the trimmed owner name and returns an invite token once', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ event_id: 'event-1', invite_token: 'secret' }], error: null })
    const repository = createEventRepository({ rpc } as never)
    const input = { name: 'Penang Trip', mode: 'trip_event', currency: 'MYR', displayName: '  Dee  ' } as const
    await expect(repository.createEvent(input)).resolves.toEqual({ eventId: 'event-1', inviteToken: 'secret' })
    expect(rpc).toHaveBeenCalledWith('create_event', { name: 'Penang Trip', mode: 'trip_event', currency: 'MYR', display_name: 'Dee' })
    expect(localStorage.getItem('preferredName')).toBe('Dee')
  })

  it('propagates createEvent rpc errors', async () => {
    const error = new Error('boom')
    const rpc = vi.fn().mockResolvedValue({ data: null, error })
    const repository = createEventRepository({ rpc } as never)
    await expect(repository.createEvent({ name: 'x', mode: 'single_bill', currency: 'MYR', displayName: 'Dee' })).rejects.toBe(error)
    expect(localStorage.getItem('preferredName')).toBeNull()
  })

  it('throws a clear error when createEvent returns no rows', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null })
    const repository = createEventRepository({ rpc } as never)
    await expect(repository.createEvent({ name: 'x', mode: 'single_bill', currency: 'MYR', displayName: 'Dee' })).rejects.toThrow(/no rows/i)
  })

  it('joins an event, remembers the trimmed preferred name and returns the event id', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ event_id: 'event-1' }], error: null })
    const repository = createEventRepository({ rpc } as never)
    await expect(repository.joinEvent('tok', '  Ali ')).resolves.toBe('event-1')
    expect(rpc).toHaveBeenCalledWith('join_event', { invite_token: 'tok', display_name: 'Ali' })
    expect(localStorage.getItem('preferredName')).toBe('Ali')
  })

  it('propagates joinEvent rpc errors and does not store the name', async () => {
    const error = new Error('invalid_invite')
    const rpc = vi.fn().mockResolvedValue({ data: null, error })
    const repository = createEventRepository({ rpc } as never)
    await expect(repository.joinEvent('bad', 'Ali')).rejects.toBe(error)
    expect(localStorage.getItem('preferredName')).toBeNull()
  })

  it('loads the event home model with attention items and the group total', async () => {
    const results: Record<string, Result> = {
      events: { data: { id: 'event-1', name: 'Penang Trip', mode: 'trip_event', currency: 'MYR', state: 'open', revision: 3 }, error: null },
      event_members: {
        data: [
          { user_id: 'user-1', display_name: 'Dee', role: 'owner' },
          { user_id: 'user-2', display_name: 'Ali', role: 'participant' },
        ],
        error: null,
      },
      expenses: {
        data: [
          { id: 'exp-2', description: 'Lunch', total_cents: 1200, payer_user_id: 'user-2', split_method: 'item_claim', created_at: '2026-10-24T12:00:00Z',
            allocations: [{ amount_cents: 400 }, { amount_cents: 300 }] },
          { id: 'exp-1', description: 'Petrol', total_cents: 9000, payer_user_id: 'user-1', split_method: 'equal', created_at: '2026-10-24T08:00:00Z',
            allocations: [{ amount_cents: 4500 }, { amount_cents: 4500 }] },
        ],
        error: null,
      },
    }
    const from = vi.fn((table: string) => builder(results[table]))
    const getSession = vi.fn().mockResolvedValue({ data: { session: { user: { id: 'user-1' } } }, error: null })
    const repository = createEventRepository({ from, auth: { getSession } } as never)

    await expect(repository.getEventHome('event-1')).resolves.toEqual({
      event: { id: 'event-1', name: 'Penang Trip', mode: 'trip_event', currency: 'MYR', state: 'open', revision: 3 },
      me: { userId: 'user-1', role: 'owner', displayName: 'Dee' },
      members: [
        { userId: 'user-1', displayName: 'Dee', role: 'owner' },
        { userId: 'user-2', displayName: 'Ali', role: 'participant' },
      ],
      expenses: [
        { id: 'exp-2', description: 'Lunch', totalCents: 1200, payerUserId: 'user-2', splitMethod: 'item_claim', createdAt: '2026-10-24T12:00:00Z' },
        { id: 'exp-1', description: 'Petrol', totalCents: 9000, payerUserId: 'user-1', splitMethod: 'equal', createdAt: '2026-10-24T08:00:00Z' },
      ],
      groupTotalCents: 10200,
      attention: [{ kind: 'unclaimed_items', expenseId: 'exp-2', description: 'Lunch', unallocatedCents: 500 }],
    })
  })

  it('rejects getEventHome when RLS hides the event from a non-member', async () => {
    const results: Record<string, Result> = {
      events: { data: null, error: null },
      event_members: { data: [], error: null },
      expenses: { data: [], error: null },
    }
    const from = vi.fn((table: string) => builder(results[table]))
    const getSession = vi.fn().mockResolvedValue({ data: { session: { user: { id: 'user-9' } } }, error: null })
    const repository = createEventRepository({ from, auth: { getSession } } as never)
    await expect(repository.getEventHome('event-1')).rejects.toThrow('not_member')
  })

  it('maps a PGRST116 no-row error on the event to not_member', async () => {
    const results: Record<string, Result> = {
      events: { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } },
      event_members: { data: [], error: null },
      expenses: { data: [], error: null },
    }
    const from = vi.fn((table: string) => builder(results[table]))
    const getSession = vi.fn().mockResolvedValue({ data: { session: { user: { id: 'user-9' } } }, error: null })
    const repository = createEventRepository({ from, auth: { getSession } } as never)
    await expect(repository.getEventHome('event-1')).rejects.toThrow('not_member')
  })

  it('changes a member role through set_member_role', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
    const repository = createEventRepository({ rpc } as never)
    await repository.setMemberRole('event-1', 'user-2', 'cohost')
    expect(rpc).toHaveBeenCalledWith('set_member_role', { event_id: 'event-1', member_id: 'user-2', role: 'cohost' })
  })

  it('maps set_member_role 22023 keys to a typed error', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: '22023', message: 'invalid_role_change' } })
    const repository = createEventRepository({ rpc } as never)
    const error = await repository.setMemberRole('event-1', 'user-1', 'participant').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ActionError)
    expect((error as ActionError).code).toBe('invalid_role_change')
  })
})
