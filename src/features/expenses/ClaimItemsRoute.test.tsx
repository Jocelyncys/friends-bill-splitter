import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventHome } from '../events/eventRepository'
import { ActionError, type ExpenseClaims } from './claimRepository'
import '../../i18n'

const mocks = vi.hoisted(() => ({
  getEventHome: vi.fn(),
  getExpenseClaims: vi.fn(),
  claimItem: vi.fn(),
  unclaimItem: vi.fn(),
  assignItem: vi.fn(),
  setClaimingClosed: vi.fn(),
}))
vi.mock('../events/eventRepository', () => ({ createEventRepository: () => ({ getEventHome: mocks.getEventHome }) }))
vi.mock('./claimRepository', async importOriginal => ({
  ...(await importOriginal<typeof import('./claimRepository')>()),
  createClaimRepository: () => mocks,
}))

import { ClaimItemsRoute } from './ClaimItemsRoute'

const home: EventHome = {
  event: { id: 'e1', name: 'Trip', mode: 'trip_event', currency: 'MYR', state: 'open', revision: 1 },
  me: { userId: 'me', displayName: 'Mia', role: 'participant' },
  members: [{ userId: 'me', displayName: 'Mia', role: 'participant' }, { userId: 'x', displayName: 'Xan', role: 'owner' }],
  expenses: [],
  groupTotalCents: 0,
  attention: [],
}
const claims: ExpenseClaims = {
  id: 'x1', eventId: 'e1', creatorUserId: 'x', description: 'Dinner', totalCents: 1000, splitMethod: 'item_claim', claimingClosed: false,
  items: [{ id: 'i1', description: 'Satay', quantity: 1, totalCents: 1000, sortOrder: 0 }],
  allocations: [],
  adjustments: [],
}

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={['/event/e1/expenses/x1/claim']}>
      <Routes><Route path="/event/:eventId/expenses/:expenseId/claim" element={<ClaimItemsRoute />} /></Routes>
    </MemoryRouter>,
  )
}

describe('ClaimItemsRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getEventHome.mockResolvedValue(home)
    mocks.getExpenseClaims.mockResolvedValue(claims)
    mocks.claimItem.mockResolvedValue(undefined)
  })

  it('reloads the claims after an action', async () => {
    renderRoute()
    await userEvent.click(await screen.findByRole('button', { name: 'Claim for me' }))
    expect(mocks.claimItem).toHaveBeenCalledWith('i1')
    await vi.waitFor(() => expect(mocks.getExpenseClaims).toHaveBeenCalledTimes(2))
  })

  it('maps a typed action error to a translated alert and still reloads', async () => {
    mocks.claimItem.mockRejectedValue(new ActionError('claiming_closed'))
    renderRoute()
    await userEvent.click(await screen.findByRole('button', { name: 'Claim for me' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Claiming is closed for this expense.')
    await vi.waitFor(() => expect(mocks.getExpenseClaims).toHaveBeenCalledTimes(2))
  })

  it('saves one item for several people as soon as their names are tapped (expense creator)', async () => {
    mocks.getExpenseClaims.mockResolvedValue({ ...claims, creatorUserId: 'me' })
    mocks.assignItem.mockResolvedValue(undefined)
    renderRoute()
    const who = await screen.findByRole('group', { name: 'Who had Satay' })
    await userEvent.click(within(who).getByRole('button', { name: 'Mia' }))
    await userEvent.click(within(who).getByRole('button', { name: 'Xan' }))
    expect(screen.queryByRole('button', { name: /^Assign/ })).not.toBeInTheDocument()
    await vi.waitFor(() => expect(mocks.assignItem).toHaveBeenCalledWith('i1', ['me', 'x']))
    expect(mocks.assignItem).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(mocks.getExpenseClaims).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
  })

  it('reverts the chips to the saved state and shows the error when the save fails', async () => {
    mocks.getExpenseClaims.mockResolvedValue({ ...claims, creatorUserId: 'me' })
    mocks.assignItem.mockRejectedValue(new ActionError('not_member'))
    renderRoute()
    const who = await screen.findByRole('group', { name: 'Who had Satay' })
    await userEvent.click(within(who).getByRole('button', { name: 'Xan' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await vi.waitFor(() => expect(within(screen.getByRole('group', { name: 'Who had Satay' })).getByRole('button', { name: 'Xan' })).toHaveAttribute('aria-pressed', 'false'))
  })

  it('keeps one item’s save error visible when another item saves fine', async () => {
    mocks.getExpenseClaims.mockResolvedValue({
      ...claims,
      creatorUserId: 'me',
      totalCents: 1500,
      items: [...claims.items, { id: 'i2', description: 'Teh', quantity: 1, totalCents: 500, sortOrder: 1 }],
    })
    mocks.assignItem.mockImplementation(async (itemId: string) => {
      if (itemId === 'i1') throw new ActionError('not_member')
    })
    renderRoute()
    await userEvent.click(within(await screen.findByRole('group', { name: 'Who had Satay' })).getByRole('button', { name: 'Xan' }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    await userEvent.click(within(screen.getByRole('group', { name: 'Who had Teh' })).getByRole('button', { name: 'Xan' }))
    await vi.waitFor(() => expect(mocks.assignItem).toHaveBeenCalledWith('i2', ['x']))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('shows the net of an older expense with several adjustment rows as one line', async () => {
    mocks.getExpenseClaims.mockResolvedValue({
      ...claims,
      totalCents: 857,
      adjustments: [
        { id: 'a1', kind: 'discount', label: 'Voucher', amountCents: -200, sortOrder: 0 },
        { id: 'a2', kind: 'tax', label: 'SST', amountCents: 57, sortOrder: 1 },
      ],
    })
    renderRoute()
    expect((await screen.findByText('Discounts, tax and rounding')).parentElement).toHaveTextContent('−RM 1.43')
    expect(screen.queryByText('Voucher')).not.toBeInTheDocument()
  })

  it('keeps the previous claims and shows a banner when a reload fails', async () => {
    renderRoute()
    await userEvent.click(await screen.findByRole('button', { name: 'Claim for me' }))
    mocks.getExpenseClaims.mockRejectedValue(new ActionError('action_failed'))
    // the reload after the click was already queued with the success mock; trigger another
    await vi.waitFor(() => expect(mocks.getExpenseClaims).toHaveBeenCalledTimes(2))
    await userEvent.click(screen.getByRole('button', { name: 'Claim for me' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load this event.')
    expect(screen.getByText('Satay')).toBeInTheDocument()
  })
})
