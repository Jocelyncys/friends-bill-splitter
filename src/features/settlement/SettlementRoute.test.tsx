import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShellContext } from '../../components/shellContext'
import type { EventHome } from '../events/eventRepository'
import type { RealtimeStatus } from '../events/useEventRealtime'
import { SettlementError, type Settlement, type SettlementInputs } from './settlementRepository'
import '../../i18n'

const mocks = vi.hoisted(() => ({
  getEventHome: vi.fn(),
  getSettlementInputs: vi.fn(),
  confirmSettlement: vi.fn(),
  getSettlement: vi.fn(),
  getReceiverDetails: vi.fn(),
  markSent: vi.fn(),
  confirmReceived: vi.fn(),
  override: vi.fn(),
  saveMyPaymentDetails: vi.fn(),
}))
vi.mock('../events/eventRepository', () => ({ createEventRepository: () => ({ getEventHome: mocks.getEventHome }) }))
vi.mock('./settlementRepository', async importOriginal => ({
  ...(await importOriginal<typeof import('./settlementRepository')>()),
  createSettlementRepository: () => mocks,
}))
vi.mock('../payments/paymentRepository', () => ({ createPaymentRepository: () => mocks }))
vi.mock('../payments/paymentPrefs', () => ({ paymentPrefs: { load: vi.fn().mockResolvedValue(null), save: vi.fn(), forget: vi.fn() } }))

import { SettlementRoute } from './SettlementRoute'

const home = (role: 'owner' | 'participant', state: 'open' | 'settled' = 'open'): EventHome => ({
  event: { id: 'e1', name: 'Trip', mode: 'trip_event', currency: 'MYR', state, revision: 4 },
  me: { userId: 'ann', displayName: 'Ann', role },
  members: [
    { userId: 'ann', displayName: 'Ann', role: 'owner' },
    { userId: 'bob', displayName: 'Bob', role: 'participant' },
  ],
  expenses: [],
  groupTotalCents: 1000,
  attention: [],
})
const inputs = (over: Partial<SettlementInputs> = {}): SettlementInputs => ({
  revision: 7,
  members: [
    { userId: 'ann', displayName: 'Ann', role: 'owner' },
    { userId: 'bob', displayName: 'Bob', role: 'participant' },
  ],
  totals: [
    { userId: 'ann', paidCents: 1000, owedCents: 500 },
    { userId: 'bob', paidCents: 0, owedCents: 500 },
  ],
  payerAllocations: [{ expenseId: 'x1', payerId: 'ann', participantId: 'bob', amountCents: 500 }],
  unresolved: [],
  ...over,
})
const settlement = (state: 'pending' | 'sent' | 'confirmed' = 'pending'): Settlement => ({
  id: 's1',
  method: 'optimized_direct',
  coordinatorId: null,
  confirmedBy: 'ann',
  confirmedAt: '2026-10-25T00:00:00Z',
  balances: [],
  transfers: [{ id: 't1', payerId: 'bob', receiverId: 'ann', amountCents: 500, state, updatedAt: '2026-10-25T00:00:00Z' }],
})

function renderRoute(phase: 'preview' | 'payment', status: RealtimeStatus = 'live') {
  const refresh = vi.fn()
  const context = { setEventName: vi.fn(), refreshKey: 0, refresh, realtimeStatus: status } satisfies ShellContext
  render(
    <MemoryRouter initialEntries={[phase === 'preview' ? '/event/e1/settle' : '/event/e1/payments']}>
      <Routes>
        <Route element={<Outlet context={context} />}>
          <Route path="/event/:eventId/settle" element={<SettlementRoute phase="preview" />} />
          <Route path="/event/:eventId/payments" element={<SettlementRoute phase="payment" />} />
          <Route path="/event/:eventId" element={<p>HOME</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
  return { refresh }
}

describe('SettlementRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getEventHome.mockResolvedValue(home('owner'))
    mocks.getSettlementInputs.mockResolvedValue(inputs())
    mocks.getSettlement.mockResolvedValue(settlement())
    mocks.confirmSettlement.mockResolvedValue('s1')
    mocks.getReceiverDetails.mockResolvedValue({ receiverUserId: 'ann', preferredMethod: 'bank', bankName: 'B', accountHolderName: 'A', accountNumber: '12345', paymentReference: null, qrUrl: null })
    for (const fn of [mocks.markSent, mocks.confirmReceived, mocks.override]) fn.mockResolvedValue(undefined)
  })

  describe('preview', () => {
    it('only the dialog confirm settles, with the loaded revision, then opens payments', async () => {
      renderRoute('preview')
      await userEvent.click(await screen.findByRole('button', { name: 'Settle now' }))
      expect(mocks.confirmSettlement).not.toHaveBeenCalled()
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm and settle' }))
      expect(mocks.confirmSettlement).toHaveBeenCalledWith({ eventId: 'e1', method: 'optimized_direct', coordinatorId: null, expectedRevision: 7 })
      expect(await screen.findByRole('heading', { name: 'Payments' })).toBeInTheDocument()
    })

    it('Later and Cancel go home without any repository mutation', async () => {
      renderRoute('preview')
      await userEvent.click(await screen.findByRole('button', { name: 'Later' }))
      expect(await screen.findByText('HOME')).toBeInTheDocument()
      expect(mocks.confirmSettlement).not.toHaveBeenCalled()
    })

    it('maps stale_revision to a message and reloads the preview', async () => {
      mocks.confirmSettlement.mockRejectedValue(new SettlementError('stale_revision'))
      renderRoute('preview')
      await userEvent.click(await screen.findByRole('button', { name: 'Settle now' }))
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm and settle' }))
      expect(await screen.findByText('Something changed. Review the updated preview.')).toBeInTheDocument()
      await vi.waitFor(() => expect(mocks.getSettlementInputs).toHaveBeenCalledTimes(2))
    })

    it('says so when the preview cannot be built', async () => {
      mocks.getSettlementInputs.mockResolvedValue(inputs({ totals: [{ userId: 'ann', paidCents: 1000, owedCents: 0 }] }))
      renderRoute('preview')
      expect(await screen.findByText('Could not build the preview.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Settle now' })).toBeDisabled()
    })

    it('blocks participants', async () => {
      mocks.getEventHome.mockResolvedValue(home('participant'))
      renderRoute('preview')
      expect(await screen.findByRole('alert')).toHaveTextContent('Only the owner or a co-host')
    })

    it('disables Settle now when realtime is not live', async () => {
      renderRoute('preview', 'offline')
      expect(await screen.findByRole('button', { name: 'Settle now' })).toBeDisabled()
      expect(screen.getByText(/Reconnecting/)).toBeInTheDocument()
    })

    it('disables Settle now when the browser is offline', async () => {
      const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
      renderRoute('preview')
      expect(await screen.findByRole('button', { name: 'Settle now' })).toBeDisabled()
      spy.mockRestore()
    })

    it('lists unresolved expenses instead of the cards', async () => {
      mocks.getSettlementInputs.mockResolvedValue(inputs({ unresolved: [{ expenseId: 'x2', description: 'Taxi', unallocatedCents: 300 }], totals: [] }))
      renderRoute('preview')
      expect(await screen.findByRole('link', { name: /Taxi/ })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Settle now' })).toBeDisabled()
      expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    })
  })

  describe('payments', () => {
    it('lists the transfer and reloads after marking it sent', async () => {
      mocks.getEventHome.mockResolvedValue({ ...home('participant', 'settled'), me: { userId: 'bob', displayName: 'Bob', role: 'participant' } })
      const { refresh } = renderRoute('payment')
      expect(await screen.findByText('Pay RM 5.00 to Ann')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: "I've sent the payment" }))
      expect(mocks.markSent).toHaveBeenCalledWith('t1')
      await vi.waitFor(() => expect(mocks.getSettlement).toHaveBeenCalledTimes(2))
      expect(refresh).toHaveBeenCalled()
    })

    it('shows a translated error when an action fails', async () => {
      mocks.getEventHome.mockResolvedValue({ ...home('owner', 'settled') })
      mocks.override.mockRejectedValue(new SettlementError('invalid_transition'))
      renderRoute('payment')
      await userEvent.click(await screen.findByRole('button', { name: 'Mark as received' }))
      await userEvent.type(screen.getByRole('textbox', { name: 'Reason' }), 'cash')
      await userEvent.click(screen.getByRole('button', { name: 'Confirm override' }))
      expect(await screen.findByText('This payment cannot move to that status.')).toBeInTheDocument()
    })

    it('tells the payer up front when the receiver has no details', async () => {
      mocks.getEventHome.mockResolvedValue({ ...home('participant', 'settled'), me: { userId: 'bob', displayName: 'Bob', role: 'participant' } })
      mocks.getReceiverDetails.mockResolvedValue(null)
      renderRoute('payment')
      expect(await screen.findByText('Waiting for Ann to add receiving details')).toBeInTheDocument()
    })

    it('says so when the event is not settled yet', async () => {
      mocks.getSettlement.mockResolvedValue(null)
      renderRoute('payment')
      expect(await screen.findByText('This event has not been settled yet.')).toBeInTheDocument()
    })
  })
})
