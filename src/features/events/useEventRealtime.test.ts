import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type StatusCallback = (status: string) => void
const mocks = vi.hoisted(() => ({
  channel: { on: vi.fn(), subscribe: vi.fn() },
  channelFactory: vi.fn(),
  removeChannel: vi.fn(),
}))
vi.mock('../../lib/supabase', () => ({ supabase: { channel: mocks.channelFactory, removeChannel: mocks.removeChannel } }))

import { useEventRealtime } from './useEventRealtime'

describe('useEventRealtime', () => {
  const flush = () => act(() => { vi.advanceTimersByTime(300) })
  let onPayload: () => void
  let onStatus: StatusCallback
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.channelFactory.mockReturnValue(mocks.channel)
    mocks.channel.on.mockImplementation((_type: string, _filter: unknown, cb: () => void) => {
      onPayload = cb
      return mocks.channel
    })
    mocks.channel.subscribe.mockImplementation((cb: StatusCallback) => {
      onStatus = cb
      return mocks.channel
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('subscribes only to the open event row and refreshes on a payload', () => {
    const refresh = vi.fn()
    renderHook(() => useEventRealtime('event-1', refresh))
    expect(mocks.channelFactory).toHaveBeenCalledWith('event:event-1')
    expect(mocks.channel.on).toHaveBeenCalledTimes(1)
    expect(mocks.channel.on).toHaveBeenCalledWith(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'events', filter: 'id=eq.event-1' },
      expect.any(Function),
    )
    act(() => onPayload())
    expect(refresh).not.toHaveBeenCalled()
    flush()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst of payloads into one refresh', () => {
    const refresh = vi.fn()
    renderHook(() => useEventRealtime('event-1', refresh))
    act(() => { onPayload(); onPayload(); onPayload() })
    flush()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('reports connecting, live and offline, and refreshes after a reconnect', () => {
    const refresh = vi.fn()
    const { result } = renderHook(() => useEventRealtime('event-1', refresh))
    expect(result.current).toBe('connecting')
    act(() => onStatus('SUBSCRIBED'))
    expect(result.current).toBe('live')
    flush()
    expect(refresh).toHaveBeenCalledTimes(1) // first subscribe catches up on missed changes
    act(() => onStatus('CHANNEL_ERROR'))
    expect(result.current).toBe('offline')
    act(() => onStatus('SUBSCRIBED'))
    expect(result.current).toBe('live')
    flush()
    expect(refresh).toHaveBeenCalledTimes(2)
    act(() => onStatus('CLOSED'))
    expect(result.current).toBe('offline')
  })

  it('removes the channel on unmount and when the event changes', () => {
    const { rerender, unmount } = renderHook(({ id }) => useEventRealtime(id, vi.fn()), { initialProps: { id: 'event-1' } })
    rerender({ id: 'event-2' })
    expect(mocks.removeChannel).toHaveBeenCalledTimes(1)
    expect(mocks.channelFactory).toHaveBeenLastCalledWith('event:event-2')
    unmount()
    expect(mocks.removeChannel).toHaveBeenCalledTimes(2)
  })

  it('ignores a late CLOSED from a removed channel of the same event (StrictMode remount)', () => {
    const callbacks: StatusCallback[] = []
    mocks.channel.subscribe.mockImplementation((cb: StatusCallback) => {
      callbacks.push(cb)
      return mocks.channel
    })
    const { result } = renderHook(() => useEventRealtime('event-1', vi.fn()), { wrapper: StrictMode })
    expect(callbacks).toHaveLength(2)
    act(() => callbacks[1]('SUBSCRIBED'))
    expect(result.current).toBe('live')
    act(() => callbacks[0]('CLOSED'))
    expect(result.current).toBe('live')
  })

  it('does not subscribe without an event id', () => {
    const { result } = renderHook(() => useEventRealtime(undefined, vi.fn()))
    expect(mocks.channelFactory).not.toHaveBeenCalled()
    expect(result.current).toBe('connecting')
  })
})
