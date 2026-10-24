import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateEventPage } from './CreateEventPage'
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
})
