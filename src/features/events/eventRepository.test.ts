import { describe, expect, it, vi } from 'vitest'
import { createEventRepository } from './eventRepository'

describe('eventRepository', () => {
  it('creates a trip using MYR and returns an invite token once', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ event_id: 'event-1', invite_token: 'secret' }], error: null })
    const repository = createEventRepository({ rpc } as never)
    const input = { name: 'Penang Trip', mode: 'trip_event', currency: 'MYR' } as const
    await expect(repository.createEvent(input)).resolves.toEqual({ eventId: 'event-1', inviteToken: 'secret' })
    expect(rpc).toHaveBeenCalledWith('create_event', input)
  })

  it('propagates createEvent rpc errors', async () => {
    const error = new Error('boom')
    const rpc = vi.fn().mockResolvedValue({ data: null, error })
    const repository = createEventRepository({ rpc } as never)
    await expect(repository.createEvent({ name: 'x', mode: 'single_bill', currency: 'MYR' })).rejects.toBe(error)
  })

  it('throws a clear error when createEvent returns no rows', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null })
    const repository = createEventRepository({ rpc } as never)
    await expect(repository.createEvent({ name: 'x', mode: 'single_bill', currency: 'MYR' })).rejects.toThrow(/no rows/i)
  })

  it('joins an event, remembers the preferred name and returns the event id', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ event_id: 'event-1' }], error: null })
    const repository = createEventRepository({ rpc } as never)
    await expect(repository.joinEvent('tok', 'Ali')).resolves.toBe('event-1')
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
})
