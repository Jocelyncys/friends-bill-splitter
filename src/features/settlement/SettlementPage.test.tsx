import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { SettlementPage } from './SettlementPage'
import { buildPreview } from './previewPlans'
import '../../i18n'

const members = [
  { userId: 'alice', displayName: 'Alice' },
  { userId: 'ben', displayName: 'Ben' },
  { userId: 'cara', displayName: 'Cara' },
  { userId: 'dan', displayName: 'Dan' },
  { userId: 'zed', displayName: 'Zed' },
]
// nets: zed +3000, alice +2000, dan +2000, ben -3500, cara -3500
const totals = [
  { userId: 'zed', paidCents: 3000, owedCents: 0 },
  { userId: 'alice', paidCents: 2000, owedCents: 0 },
  { userId: 'dan', paidCents: 2000, owedCents: 0 },
  { userId: 'ben', paidCents: 0, owedCents: 3500 },
  { userId: 'cara', paidCents: 0, owedCents: 3500 },
]
const payerAllocations = [
  { expenseId: 'x1', payerId: 'zed', participantId: 'ben', amountCents: 3000 },
  { expenseId: 'x2', payerId: 'alice', participantId: 'cara', amountCents: 2000 },
  { expenseId: 'x3', payerId: 'dan', participantId: 'cara', amountCents: 1500 },
  { expenseId: 'x3', payerId: 'dan', participantId: 'ben', amountCents: 500 },
]
const preview = buildPreview(members, totals, payerAllocations)

function renderPreview(extra: Partial<React.ComponentProps<typeof SettlementPage>> = {}) {
  const handlers = { onCancel: vi.fn(), onLater: vi.fn(), onSettleNow: vi.fn() }
  render(<SettlementPage phase="preview" transfers={[]} preview={preview} {...handlers} {...extra} />)
  return handlers
}

const card = (name: RegExp) => screen.getByRole('radio', { name }).closest('article') as HTMLElement

describe('SettlementPage', () => {
  it('does not lock an event when settlement preview is cancelled', async () => {
    const cancel = vi.fn()
    render(<SettlementPage phase="preview" transfers={[]} onCancel={cancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('requests payment details only from receivers', () => {
    render(<SettlementPage phase="payment" currentUserId="ben" transfers={[{ payerId: 'alice', receiverId: 'ben', amountCents: 1000 }]} />)
    expect(screen.getByText('Add receiving details')).toBeInTheDocument()
  })

  it('does not request payment details from payers', () => {
    render(<SettlementPage phase="payment" currentUserId="alice" transfers={[{ payerId: 'alice', receiverId: 'ben', amountCents: 1000 }]} />)
    expect(screen.queryByText('Add receiving details')).not.toBeInTheDocument()
  })

  describe('preview', () => {
    it('shows three cards in order with a Recommended badge on the optimized one', () => {
      renderPreview()
      const radios = screen.getAllByRole('radio')
      expect(radios.map(r => r.closest('article')?.querySelector('strong')?.textContent)).toEqual([
        'Pay original payers',
        'Optimized direct settlement',
        'Settlement coordinator',
      ])
      expect(within(radios[1].closest('article') as HTMLElement).getByText('Recommended')).toBeInTheDocument()
      expect(screen.getAllByText('Recommended')).toHaveLength(1)
    })

    it('shows totals, net balances in words and the transfer count', () => {
      renderPreview()
      const optimized = card(/Optimized direct settlement/)
      expect(within(optimized).getByText(/Total paid/)).toHaveTextContent('RM 70.00')
      expect(within(optimized).getByText(/Total owed/)).toHaveTextContent('RM 70.00')
      expect(within(optimized).getByText('Zed receives RM 30.00')).toBeInTheDocument()
      expect(within(optimized).getByText('Ben pays RM 35.00')).toBeInTheDocument()
      expect(within(optimized).getByText(/^Transfers: \d+$/)).toHaveTextContent(`Transfers: ${preview.plans.optimized.length}`)
      expect(within(optimized).getAllByRole('listitem').length).toBeGreaterThanOrEqual(preview.plans.optimized.length)
    })

    it('offers only creditors as coordinators, sorted by credit then name, first preselected', () => {
      renderPreview()
      const select = screen.getByRole('combobox', { name: 'Coordinator' })
      expect(within(select).getAllByRole('option').map(o => o.textContent)).toEqual(['Zed', 'Alice', 'Dan'])
      expect(select).toHaveValue('zed')
    })

    it('opens a confirmation dialog and calls onSettleNow only on confirm', async () => {
      const { onSettleNow } = renderPreview()
      await userEvent.click(screen.getByRole('button', { name: 'Settle now' }))
      expect(onSettleNow).not.toHaveBeenCalled()
      const dialog = screen.getByRole('dialog')
      expect(dialog).toHaveTextContent('Optimized direct settlement')
      expect(dialog).toHaveTextContent('read-only')
      expect(dialog).toHaveTextContent('create a new event')
      await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm and settle' }))
      expect(onSettleNow).toHaveBeenCalledWith('optimized_direct', null)
    })

    it('passes the chosen coordinator', async () => {
      const { onSettleNow } = renderPreview()
      await userEvent.click(screen.getByRole('radio', { name: /Settlement coordinator/ }))
      await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Coordinator' }), 'alice')
      await userEvent.click(screen.getByRole('button', { name: 'Settle now' }))
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm and settle' }))
      expect(onSettleNow).toHaveBeenCalledWith('coordinator', 'alice')
    })

    it('can back out of the dialog without calling anything', async () => {
      const { onSettleNow, onCancel, onLater } = renderPreview()
      await userEvent.click(screen.getByRole('button', { name: 'Settle now' }))
      await userEvent.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect([onSettleNow, onCancel, onLater].every(fn => fn.mock.calls.length === 0)).toBe(true)
    })

    it('closes the dialog and never settles when a block appears while it is open', async () => {
      const handlers = { onCancel: vi.fn(), onLater: vi.fn(), onSettleNow: vi.fn() }
      const { rerender } = render(<SettlementPage phase="preview" transfers={[]} preview={preview} revision={1} {...handlers} />)
      await userEvent.click(screen.getByRole('button', { name: 'Settle now' }))
      rerender(<SettlementPage phase="preview" transfers={[]} preview={preview} revision={1} settleBlockedMessage="You are offline." {...handlers} />)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      rerender(<SettlementPage phase="preview" transfers={[]} preview={preview} revision={1} {...handlers} />)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(handlers.onSettleNow).not.toHaveBeenCalled()
    })

    it('closes the dialog and shows the stale message when the revision changes under it', async () => {
      const handlers = { onCancel: vi.fn(), onLater: vi.fn(), onSettleNow: vi.fn() }
      const { rerender } = render(<SettlementPage phase="preview" transfers={[]} preview={preview} revision={1} {...handlers} />)
      await userEvent.click(screen.getByRole('button', { name: 'Settle now' }))
      rerender(<SettlementPage phase="preview" transfers={[]} preview={preview} revision={2} {...handlers} />)
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(screen.getByText('Something changed. Review the updated preview.')).toBeInTheDocument()
      expect(handlers.onSettleNow).not.toHaveBeenCalled()
    })

    it('Later and Cancel only call their own callbacks', async () => {
      const { onSettleNow, onCancel, onLater } = renderPreview()
      await userEvent.click(screen.getByRole('button', { name: 'Later' }))
      expect(onLater).toHaveBeenCalledOnce()
      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(onCancel).toHaveBeenCalledOnce()
      expect(onSettleNow).not.toHaveBeenCalled()
    })

    it('lists unresolved expenses and disables Settle now', async () => {
      render(
        <MemoryRouter>
          <SettlementPage phase="preview" transfers={[]} preview={preview} eventId="e1" unresolved={[{ expenseId: 'x9', description: 'Taxi', unallocatedCents: 500 }]} />
        </MemoryRouter>,
      )
      expect(screen.getByRole('button', { name: 'Settle now' })).toBeDisabled()
      expect(screen.getByRole('link', { name: /Taxi/ })).toHaveAttribute('href', '/event/e1/expenses/x9/claim')
    })

    it('disables Settle now with a reason when blocked', () => {
      renderPreview({ settleBlockedMessage: 'You are offline.' })
      expect(screen.getByRole('button', { name: 'Settle now' })).toBeDisabled()
      expect(screen.getByText('You are offline.')).toBeInTheDocument()
    })
  })

  describe('payment phase', () => {
    const base = { payerId: 'alice', receiverId: 'ben', amountCents: 8540, id: 't1' }
    const names = { alice: 'Alice', ben: 'Ben' }

    it('writes transfers as sentences', () => {
      render(<SettlementPage phase="payment" currentUserId="alice" names={names} transfers={[{ ...base, state: 'pending' }]} />)
      expect(screen.getByText('Pay RM 85.40 to Ben')).toBeInTheDocument()
    })

    it('shows the send button to the payer only while pending', () => {
      const sent = { name: "I've sent the payment" }
      const { rerender } = render(<SettlementPage phase="payment" currentUserId="alice" names={names} transfers={[{ ...base, state: 'pending' }]} onMarkSent={vi.fn()} />)
      expect(screen.getByRole('button', sent)).toBeInTheDocument()
      rerender(<SettlementPage phase="payment" currentUserId="alice" names={names} transfers={[{ ...base, state: 'sent' }]} onMarkSent={vi.fn()} />)
      expect(screen.queryByRole('button', sent)).not.toBeInTheDocument()
      rerender(<SettlementPage phase="payment" currentUserId="ben" names={names} transfers={[{ ...base, state: 'pending' }]} onMarkSent={vi.fn()} />)
      expect(screen.queryByRole('button', sent)).not.toBeInTheDocument()
    })

    it('shows "Payment received" to the receiver only when sent, and calls the handler', async () => {
      const confirm = vi.fn()
      const { rerender } = render(<SettlementPage phase="payment" currentUserId="ben" names={names} transfers={[{ ...base, state: 'pending' }]} onConfirmReceived={confirm} />)
      expect(screen.queryByRole('button', { name: 'Payment received' })).not.toBeInTheDocument()
      rerender(<SettlementPage phase="payment" currentUserId="ben" names={names} transfers={[{ ...base, state: 'sent' }]} onConfirmReceived={confirm} />)
      await userEvent.click(screen.getByRole('button', { name: 'Payment received' }))
      expect(confirm).toHaveBeenCalledWith('t1')
    })

    it('requires a reason for the manager override', async () => {
      const override = vi.fn()
      render(<SettlementPage phase="payment" currentUserId="owner" role="owner" names={names} transfers={[{ ...base, state: 'sent' }]} onOverride={override} />)
      await userEvent.click(screen.getByRole('button', { name: 'Mark as received' }))
      await userEvent.click(screen.getByRole('button', { name: 'Confirm override' }))
      expect(override).not.toHaveBeenCalled()
      expect(screen.getByRole('alert')).toHaveTextContent('reason')
      await userEvent.type(screen.getByRole('textbox', { name: 'Reason' }), 'Paid in cash')
      await userEvent.click(screen.getByRole('button', { name: 'Confirm override' }))
      expect(override).toHaveBeenCalledWith('t1', 'Paid in cash')
    })

    it('does not offer the override to participants or on received transfers', () => {
      const { rerender } = render(<SettlementPage phase="payment" currentUserId="alice" role="participant" names={names} transfers={[{ ...base, state: 'sent' }]} />)
      expect(screen.queryByRole('button', { name: 'Mark as received' })).not.toBeInTheDocument()
      rerender(<SettlementPage phase="payment" currentUserId="owner" role="owner" names={names} transfers={[{ ...base, state: 'confirmed' }]} />)
      expect(screen.queryByRole('button', { name: 'Mark as received' })).not.toBeInTheDocument()
    })

    it('warns proactively when the receiver has no details, and before marking sent', async () => {
      const sent = vi.fn()
      render(<SettlementPage phase="payment" currentUserId="alice" names={names} transfers={[{ ...base, state: 'pending' }]} missingDetailsFor={['t1']} onMarkSent={sent} />)
      expect(screen.getByText('Waiting for Ben to add receiving details')).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: "I've sent the payment" }))
      expect(sent).not.toHaveBeenCalled()
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Mark as sent' }))
      expect(sent).toHaveBeenCalledWith('t1')
    })

    it('keeps the override reason when the action fails', async () => {
      const override = vi.fn().mockResolvedValue(false)
      render(<SettlementPage phase="payment" currentUserId="owner" role="owner" names={names} transfers={[{ ...base, state: 'sent' }]} onOverride={override} />)
      await userEvent.click(screen.getByRole('button', { name: 'Mark as received' }))
      await userEvent.type(screen.getByRole('textbox', { name: 'Reason' }), 'Paid in cash')
      await userEvent.click(screen.getByRole('button', { name: 'Confirm override' }))
      expect(override).toHaveBeenCalledOnce()
      expect(await screen.findByRole('textbox', { name: 'Reason' })).toHaveValue('Paid in cash')
    })

    it('names an unknown member as a former member', () => {
      render(<SettlementPage phase="payment" currentUserId="alice" names={{ alice: 'Alice' }} transfers={[{ ...base, state: 'pending' }]} />)
      expect(screen.getByText('Pay RM 85.40 to Former member')).toBeInTheDocument()
    })

    it('shows payment details on request, and a waiting note when the receiver has none', async () => {
      const load = vi
        .fn()
        .mockResolvedValueOnce({ receiverUserId: 'ben', preferredMethod: 'bank', bankName: 'Maybank', accountHolderName: 'Ben Tan', accountNumber: '1234567890', paymentReference: null, qrUrl: null })
        .mockResolvedValueOnce(null)
      render(<SettlementPage phase="payment" currentUserId="alice" names={names} transfers={[{ ...base, state: 'pending' }, { ...base, id: 't2', state: 'pending' }]} onShowDetails={load} />)
      await userEvent.click(screen.getAllByRole('button', { name: 'Show payment details' })[0])
      expect(await screen.findByText('1234567890')).toBeInTheDocument()
      await userEvent.click(screen.getAllByRole('button', { name: 'Show payment details' })[1])
      expect(await screen.findByText('Waiting for Ben to add receiving details')).toBeInTheDocument()
    })

    it('hides payment details once the transfer is received', () => {
      render(<SettlementPage phase="payment" currentUserId="alice" names={names} transfers={[{ ...base, state: 'confirmed' }]} onShowDetails={vi.fn()} />)
      expect(screen.queryByRole('button', { name: 'Show payment details' })).not.toBeInTheDocument()
      expect(screen.getByText('Received')).toBeInTheDocument()
    })
  })
})
