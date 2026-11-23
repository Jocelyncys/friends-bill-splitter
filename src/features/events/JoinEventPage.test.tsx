import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'

const mocks = vi.hoisted(() => ({ listInviteGuests: vi.fn(), joinEvent: vi.fn() }))
vi.mock('./eventRepository', () => ({ createEventRepository: () => mocks }))
vi.mock('../auth/anonymousSession', () => ({ ensureAnonymousSession: vi.fn().mockResolvedValue(undefined) }))

import { JoinEventPage } from './JoinEventPage'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/join/tok']}>
      <Routes>
        <Route path="/join/:token" element={<JoinEventPage />} />
        <Route path="/event/:eventId" element={<p>Event page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('JoinEventPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mocks.joinEvent.mockResolvedValue('e1')
  })

  it('joins as a new person when the host added nobody', async () => {
    mocks.listInviteGuests.mockResolvedValue([])
    renderPage()
    await userEvent.type(screen.getByRole('textbox', { name: 'Your name' }), 'Ali')
    await userEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(mocks.joinEvent).toHaveBeenCalledWith('tok', 'Ali', undefined)
    expect(await screen.findByText('Event page')).toBeInTheDocument()
    expect(screen.queryByText('Are you one of these people?')).not.toBeInTheDocument()
  })

  it('lets the joiner take over a host-added name', async () => {
    mocks.listInviteGuests.mockResolvedValue([{ memberId: 'g1', displayName: 'Chen' }, { memberId: 'g2', displayName: 'Dan' }])
    renderPage()
    await userEvent.click(await screen.findByRole('radio', { name: 'Chen' }))
    expect(screen.getByRole('textbox', { name: 'Your name' })).toHaveValue('Chen')
    await userEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(mocks.joinEvent).toHaveBeenCalledWith('tok', 'Chen', 'g1')
  })

  it('defaults to joining as a new person and still joins when listing guests fails', async () => {
    mocks.listInviteGuests.mockRejectedValue(new Error('offline'))
    renderPage()
    await userEvent.type(screen.getByRole('textbox', { name: 'Your name' }), 'Ali')
    await userEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(mocks.joinEvent).toHaveBeenCalledWith('tok', 'Ali', undefined)
  })

  it('explains already_member', async () => {
    mocks.listInviteGuests.mockResolvedValue([{ memberId: 'g1', displayName: 'Chen' }])
    mocks.joinEvent.mockRejectedValue({ message: 'already_member' })
    renderPage()
    await userEvent.click(await screen.findByRole('radio', { name: 'Chen' }))
    await userEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('You have already joined this event')
  })
})
