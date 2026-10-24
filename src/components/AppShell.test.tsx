import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RealtimeStatus } from '../features/events/useEventRealtime'
import '../i18n'

const mocks = vi.hoisted(() => ({ status: 'live' as RealtimeStatus, subscribedTo: vi.fn() }))
vi.mock('../features/events/useEventRealtime', () => ({
  useEventRealtime: (eventId: string | undefined) => {
    mocks.subscribedTo(eventId)
    return mocks.status
  },
}))

import { AppShell } from './AppShell'

function renderAt(path: string) {
  const router = createMemoryRouter(
    [{ element: <AppShell />, children: [{ path: '/', element: <p>start</p> }, { path: '/event/:eventId', element: <p>event page</p> }] }],
    { initialEntries: [path] },
  )
  return render(<RouterProvider router={router} />)
}

describe('AppShell stale-state banner', () => {
  beforeEach(() => {
    mocks.status = 'live'
    mocks.subscribedTo.mockClear()
  })

  it('warns that data may be out of date while realtime is offline inside an event', () => {
    mocks.status = 'offline'
    renderAt('/event/e1')
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting… data may be out of date.')
    expect(mocks.subscribedTo).toHaveBeenCalledWith('e1')
  })

  it('shows no banner while live or connecting, or outside an event', () => {
    renderAt('/event/e1')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows no banner outside an event even if the status is offline', () => {
    mocks.status = 'offline'
    renderAt('/')
    expect(screen.queryByText(/Reconnecting/)).not.toBeInTheDocument()
  })
})
