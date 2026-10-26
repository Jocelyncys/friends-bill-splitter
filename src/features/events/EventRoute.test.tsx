import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventRoute } from './EventRoute'
import '../../i18n'

const home = {
  event: { id: 'ev-1', name: 'Penang Trip', mode: 'trip_event', currency: 'MYR', state: 'open', revision: 1 },
  me: { userId: 'u-a', role: 'owner', displayName: 'Ana' },
  members: [{ userId: 'u-a', role: 'owner', displayName: 'Ana' }],
  expenses: [],
  groupTotalCents: 0,
  attention: [],
}
vi.mock('./useEventHome', () => ({ useEventHome: () => ({ status: 'ready', home }) }))
vi.mock('./useMyPosition', () => ({ useMyPosition: () => null }))
vi.mock('../offline/useDrafts', () => ({ useDrafts: () => ({ drafts: [], loaded: true }) }))
vi.mock('../offline/DraftList', () => ({ DraftList: () => null }))

function StateProbe() {
  const state = useLocation().state as { showInvite?: boolean } | null
  return <p>{`state: ${state?.showInvite ? 'invite' : 'none'}`}</p>
}

describe('EventRoute', () => {
  beforeEach(() => localStorage.setItem('inviteToken:ev-1', 'tok-1'))

  it('opens the invite for this visit only: the history state is cleared after reading it', async () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: '/event/ev-1', state: { showInvite: true } }]}>
        <Routes>
          <Route
            path="/event/:eventId"
            element={
              <>
                <EventRoute />
                <StateProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    )
    expect(await screen.findByText('state: none')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Share invite' })).toBeInTheDocument()
  })

  it('keeps the invite closed without the state', () => {
    render(
      <MemoryRouter initialEntries={['/event/ev-1']}>
        <Routes>
          <Route path="/event/:eventId" element={<EventRoute />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.queryByRole('button', { name: 'Share invite' })).not.toBeInTheDocument()
  })
})
