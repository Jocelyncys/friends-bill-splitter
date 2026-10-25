import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateEventPage } from './CreateEventPage'
import { InvitePanel } from './InvitePanel'
import '../../i18n'

const createEvent = vi.fn()
vi.mock('./eventRepository', () => ({ createEventRepository: () => ({ createEvent }) }))
vi.mock('../auth/anonymousSession', () => ({ ensureAnonymousSession: vi.fn().mockResolvedValue('user-1') }))

beforeEach(() => {
  createEvent.mockReset()
  createEvent.mockResolvedValue({ eventId: 'ev-9', inviteToken: 'tok-abc' })
})

describe('CreateEventPage', () => {
  it('creates the event, stores the invite token and navigates to the event', async () => {
    localStorage.setItem('preferredName', 'Joc')
    render(
      <MemoryRouter initialEntries={['/new/trip_event']}>
        <Routes>
          <Route path="/new/:mode" element={<CreateEventPage />} />
          <Route path="/event/:eventId" element={<p>event home</p>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Your name')).toHaveValue('Joc')
    await userEvent.type(screen.getByLabelText('Event name'), 'Penang Trip')
    await userEvent.click(screen.getByRole('button', { name: 'Create event' }))

    expect(await screen.findByText('event home')).toBeInTheDocument()
    expect(createEvent).toHaveBeenCalledWith({ name: 'Penang Trip', mode: 'trip_event', currency: 'MYR', displayName: 'Joc' })
    expect(localStorage.getItem('inviteToken:ev-9')).toBe('tok-abc')
  })

  it('still navigates and shows the invite link once with a warning when it cannot be stored', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    function Landing() {
      const state = useLocation().state as { unsavedInviteToken?: string } | null
      return <InvitePanel eventId="ev-9" token={state?.unsavedInviteToken} />
    }
    try {
      render(
        <MemoryRouter initialEntries={['/new/single_bill']}>
          <Routes>
            <Route path="/new/:mode" element={<CreateEventPage />} />
            <Route path="/event/:eventId" element={<Landing />} />
          </Routes>
        </MemoryRouter>,
      )
      await userEvent.type(screen.getByLabelText('Event name'), 'Dinner')
      await userEvent.type(screen.getByLabelText('Your name'), 'Joc')
      await userEvent.click(screen.getByRole('button', { name: 'Create event' }))
      expect((await screen.findByLabelText<HTMLInputElement>('Invite link')).value).toContain('#/join/tok-abc')
      expect(screen.getByRole('alert')).toHaveTextContent('could not be saved on this device')
    } finally {
      setItem.mockRestore()
    }
  })
})
