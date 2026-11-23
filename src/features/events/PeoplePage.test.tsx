import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventHome, EventMember } from './eventRepository'
import { ActionError } from '../expenses/claimRepository'
import '../../i18n'

const mocks = vi.hoisted(() => ({ getEventHome: vi.fn(), setMemberRole: vi.fn(), addGuest: vi.fn(), removeGuest: vi.fn() }))
vi.mock('./eventRepository', () => ({ createEventRepository: () => mocks }))

import { PeoplePage } from './PeoplePage'

const members: EventMember[] = [
  { userId: 'o', displayName: 'Olive', role: 'owner' },
  { userId: 'c', displayName: 'Cam', role: 'cohost' },
  { userId: 'p', displayName: 'Pat', role: 'participant' },
  { userId: 'p2', displayName: 'pat', role: 'participant' },
]
function home(meId: string): EventHome {
  return {
    event: { id: 'e1', name: 'Trip', mode: 'trip_event', currency: 'MYR', state: 'open', revision: 1 },
    me: members.find(m => m.userId === meId)!,
    members,
    expenses: [],
    groupTotalCents: 0,
    attention: [],
  }
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/event/e1/people']}>
      <Routes><Route path="/event/:eventId/people" element={<PeoplePage />} /></Routes>
    </MemoryRouter>,
  )
}

describe('PeoplePage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.setMemberRole.mockResolvedValue(undefined)
    mocks.addGuest.mockResolvedValue('g1')
    mocks.removeGuest.mockResolvedValue(undefined)
  })

  it('lists roles, marks me and tells duplicate names apart', async () => {
    mocks.getEventHome.mockResolvedValue(home('o'))
    renderPage()
    expect(await screen.findByText('Olive (you)')).toBeInTheDocument()
    expect(screen.getByText('Owner')).toBeInTheDocument()
    expect(screen.getByText('Co-host')).toBeInTheDocument()
    expect(screen.getByText('Pat (1)')).toBeInTheDocument()
    expect(screen.getByText('pat (2)')).toBeInTheDocument()
  })

  it('lets only the owner change roles of non-owner members', async () => {
    mocks.getEventHome.mockResolvedValue(home('o'))
    renderPage()
    await userEvent.click(await screen.findByRole('button', { name: 'Make participant: Cam' }))
    expect(mocks.setMemberRole).toHaveBeenCalledWith('e1', 'c', 'participant')
    await userEvent.click(screen.getByRole('button', { name: 'Make co-host: Pat (1)' }))
    expect(mocks.setMemberRole).toHaveBeenCalledWith('e1', 'p', 'cohost')
    expect(screen.getAllByRole('button', { name: /Make (co-host|participant)/ })).toHaveLength(3)
  })

  it('shows no role controls to a co-host', async () => {
    mocks.getEventHome.mockResolvedValue(home('c'))
    renderPage()
    await screen.findByText('Cam (you)')
    expect(screen.queryByRole('button', { name: /Make (co-host|participant)/ })).not.toBeInTheDocument()
  })

  it('disables role changes while offline', async () => {
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    mocks.getEventHome.mockResolvedValue(home('o'))
    renderPage()
    expect(await screen.findByRole('button', { name: 'Make participant: Cam' })).toBeDisabled()
    expect(screen.getByText(/You are offline/)).toBeInTheDocument()
    spy.mockRestore()
  })

  it('hides role buttons on a settled event and says it is settled', async () => {
    const settled = home('o')
    settled.event.state = 'settled'
    mocks.getEventHome.mockResolvedValue(settled)
    renderPage()
    expect(await screen.findByText('This event is settled. Expenses are now read-only.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /co-host|participant/i })).not.toBeInTheDocument()
  })

  describe('host-added people', () => {
    function withGuest(meId: string): EventHome {
      const h = home(meId)
      return { ...h, members: [...h.members, { userId: 'g', displayName: 'Chen', role: 'participant', isGuest: true }] }
    }

    it('lets the owner add a person by name', async () => {
      mocks.getEventHome.mockResolvedValue(home('o'))
      renderPage()
      await userEvent.type(await screen.findByRole('textbox', { name: 'Name' }), 'Chen')
      await userEvent.click(screen.getByRole('button', { name: 'Add' }))
      expect(mocks.addGuest).toHaveBeenCalledWith('e1', 'Chen')
      await vi.waitFor(() => expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue(''))
    })

    it('lets a co-host add people too, but not a participant', async () => {
      mocks.getEventHome.mockResolvedValue(home('c'))
      const { unmount } = renderPage()
      expect(await screen.findByRole('heading', { name: 'Add someone without inviting them' })).toBeInTheDocument()
      unmount()
      mocks.getEventHome.mockResolvedValue(home('p'))
      renderPage()
      await screen.findByText('Pat (1) (you)')
      expect(screen.queryByRole('heading', { name: 'Add someone without inviting them' })).not.toBeInTheDocument()
    })

    it('marks guests, offers remove instead of a role change, and shows a failed remove', async () => {
      mocks.getEventHome.mockResolvedValue(withGuest('o'))
      mocks.removeGuest.mockRejectedValue(new ActionError('member_in_use'))
      renderPage()
      expect(await screen.findByText('Added by host')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Make co-host: Chen' })).not.toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Remove Chen' }))
      expect(mocks.removeGuest).toHaveBeenCalledWith('e1', 'g')
      expect(await screen.findByRole('alert')).toHaveTextContent('This person is in an expense.')
    })

    it('hides adding people on a settled event', async () => {
      const settled = withGuest('o')
      settled.event = { ...settled.event, state: 'settled' }
      mocks.getEventHome.mockResolvedValue(settled)
      renderPage()
      await screen.findByText('Added by host')
      expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Remove Chen' })).not.toBeInTheDocument()
    })
  })
})
