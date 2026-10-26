import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ClaimItemsPage, type ClaimItemView } from './ClaimItemsPage'
import '../../i18n'

const participants = [{ id: 'alice', name: 'Alice' }, { id: 'ben', name: 'Ben' }]
const unclaimed: ClaimItemView = { id: 'i1', description: 'Satay', quantity: 1, totalCents: 1001, claims: [], assigned: false }

describe('ClaimItemsPage', () => {
  it('lets a participant claim for themselves but not assign another person', async () => {
    render(<ClaimItemsPage role="participant" currentUserId="alice" participants={[{ id: 'alice', name: 'Alice' }, { id: 'ben', name: 'Ben' }]} items={[unclaimed]} />)
    expect(screen.getByRole('button', { name: 'Claim for me' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Assign Satay' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Who had Satay' })).not.toBeInTheDocument()
  })

  it('calls onClaim and onUnclaim with the item id', async () => {
    const onClaim = vi.fn()
    const onUnclaim = vi.fn()
    const { rerender } = render(<ClaimItemsPage role="participant" currentUserId="alice" participants={participants} items={[unclaimed]} onClaim={onClaim} onUnclaim={onUnclaim} />)
    await userEvent.click(screen.getByRole('button', { name: 'Claim for me' }))
    expect(onClaim).toHaveBeenCalledWith('i1')
    rerender(<ClaimItemsPage role="participant" currentUserId="alice" participants={participants} items={[{ ...unclaimed, claims: [{ userId: 'alice', amountCents: 1001 }] }]} onClaim={onClaim} onUnclaim={onUnclaim} />)
    await userEvent.click(screen.getByRole('button', { name: 'Unclaim' }))
    expect(onUnclaim).toHaveBeenCalledWith('i1')
  })

  it('shows claimers, unclaim for my own claim, and each person’s share in money', () => {
    const items: ClaimItemView[] = [{ ...unclaimed, claims: [{ userId: 'alice', amountCents: 501 }, { userId: 'ben', amountCents: 500 }] }]
    render(<ClaimItemsPage role="participant" currentUserId="alice" participants={participants} items={items} />)
    expect(screen.getByRole('button', { name: 'Unclaim' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Claim for me' })).not.toBeInTheDocument()
    expect(screen.getByText('Claimed by: Alice, Ben')).toBeInTheDocument()
    const shares = screen.getByRole('list', { name: 'Each person’s share' })
    expect(within(shares).getByText('Alice')).toBeInTheDocument()
    expect(within(shares).getByText('RM 5.01')).toBeInTheDocument()
    expect(within(shares).getByText('RM 5.00')).toBeInTheDocument()
  })

  it('gives managers one people picker per item (no Assign button) and a close/reopen toggle', async () => {
    const onToggleClosed = vi.fn()
    render(<ClaimItemsPage role="cohost" currentUserId="alice" canManage participants={participants} items={[unclaimed]} onToggleClosed={onToggleClosed} />)
    const who = screen.getByRole('group', { name: 'Who had Satay' })
    expect(within(who).getAllByRole('button')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: /^Assign/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Close claiming' }))
    expect(onToggleClosed).toHaveBeenCalledWith(true)
  })

  it('disables claiming when closed (managers can still assign) and offers reopen', () => {
    render(<ClaimItemsPage role="owner" currentUserId="alice" claimingClosed participants={participants} items={[unclaimed]} />)
    expect(screen.getByRole('button', { name: 'Claim for me' })).toBeDisabled()
    expect(within(screen.getByRole('group', { name: 'Who had Satay' })).getByRole('button', { name: 'Ben' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Reopen claiming' })).toBeEnabled()
  })

  it('shows assigned items as assigned and hides self-claim buttons', () => {
    const items: ClaimItemView[] = [{ ...unclaimed, assigned: true, claims: [{ userId: 'ben', amountCents: 1001 }] }]
    render(<ClaimItemsPage role="participant" currentUserId="alice" participants={participants} items={items} />)
    expect(screen.getByText('Assigned to: Ben')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Claim for me' })).not.toBeInTheDocument()
  })

  it('hides claim buttons when the expense is not claim-by-friends', () => {
    render(<ClaimItemsPage role="participant" currentUserId="alice" splitMethod="host_assignment" participants={participants} items={[unclaimed]} />)
    expect(screen.queryByRole('button', { name: 'Claim for me' })).not.toBeInTheDocument()
  })

  it('disables every mutation while offline and announces action errors', () => {
    render(<ClaimItemsPage role="owner" currentUserId="alice" offline errorMessage="Claiming is closed." participants={participants} items={[unclaimed]} />)
    expect(screen.getByRole('button', { name: 'Claim for me' })).toBeDisabled()
    expect(within(screen.getByRole('group', { name: 'Who had Satay' })).getByRole('button', { name: 'Ben' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close claiming' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Claiming is closed.')
  })

  describe('saving as soon as a name is tapped', () => {
    const assignedToAlice: ClaimItemView = { ...unclaimed, assigned: true, claims: [{ userId: 'alice', amountCents: 1001 }] }
    const chip = (name: string) => within(screen.getByRole('group', { name: 'Who had Satay' })).getByRole('button', { name })

    it('starts from the current assignees and sends one call for quick taps, after a short pause', async () => {
      const onAssign = vi.fn().mockResolvedValue(true)
      render(<ClaimItemsPage role="owner" currentUserId="alice" participants={participants} items={[assignedToAlice]} onAssign={onAssign} />)
      expect(chip('Alice')).toHaveAttribute('aria-pressed', 'true')
      expect(chip('Ben')).toHaveAttribute('aria-pressed', 'false')
      await userEvent.click(chip('Ben'))
      await userEvent.click(chip('Alice'))
      expect(chip('Alice')).toHaveAttribute('aria-pressed', 'false')
      expect(chip('Ben')).toHaveAttribute('aria-pressed', 'true')
      expect(onAssign).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(onAssign).toHaveBeenCalledTimes(1))
      expect(onAssign).toHaveBeenCalledWith('i1', ['ben'])
      expect(await screen.findByText('Saved')).toHaveAttribute('aria-live', 'polite')
      await new Promise(r => setTimeout(r, 500))
      expect(onAssign).toHaveBeenCalledTimes(1)
    })

    it('shows Saving… and locks that item’s chips while the save is in flight', async () => {
      let finish: (ok: boolean) => void = () => {}
      const onAssign = vi.fn().mockReturnValue(new Promise<boolean>(r => { finish = r }))
      render(<ClaimItemsPage role="owner" currentUserId="alice" participants={participants} items={[unclaimed]} onAssign={onAssign} />)
      await userEvent.click(chip('Ben'))
      expect(await screen.findByText('Saving…')).toBeInTheDocument()
      expect(chip('Ben')).toBeDisabled()
      await act(async () => finish(true))
      expect(screen.getByText('Saved')).toBeInTheDocument()
      expect(chip('Ben')).toBeEnabled()
    })

    it('goes back to the saved people when the save fails', async () => {
      const onAssign = vi.fn().mockResolvedValue(false)
      render(<ClaimItemsPage role="owner" currentUserId="alice" participants={participants} items={[assignedToAlice]} onAssign={onAssign} />)
      await userEvent.click(chip('Ben'))
      expect(chip('Ben')).toHaveAttribute('aria-pressed', 'true')
      await vi.waitFor(() => expect(onAssign).toHaveBeenCalledWith('i1', ['alice', 'ben']))
      await vi.waitFor(() => expect(chip('Ben')).toHaveAttribute('aria-pressed', 'false'))
      expect(chip('Alice')).toHaveAttribute('aria-pressed', 'true')
      expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    })

    it('clears the item when the last person is taken off', async () => {
      const onAssign = vi.fn().mockResolvedValue(true)
      render(<ClaimItemsPage role="owner" currentUserId="alice" participants={participants} items={[assignedToAlice]} onAssign={onAssign} />)
      await userEvent.click(chip('Alice'))
      await vi.waitFor(() => expect(onAssign).toHaveBeenCalledWith('i1', []))
    })

    it('sends nothing when the taps end where they started', async () => {
      const onAssign = vi.fn().mockResolvedValue(true)
      render(<ClaimItemsPage role="owner" currentUserId="alice" participants={participants} items={[assignedToAlice]} onAssign={onAssign} />)
      await userEvent.click(chip('Ben'))
      await userEvent.click(chip('Ben'))
      await new Promise(r => setTimeout(r, 600))
      expect(onAssign).not.toHaveBeenCalled()
    })
  })

  it('shows a shared item as shared, with each person’s part', () => {
    const items: ClaimItemView[] = [{ ...unclaimed, assigned: true, claims: [{ userId: 'alice', amountCents: 501 }, { userId: 'ben', amountCents: 500 }] }]
    render(<ClaimItemsPage role="participant" currentUserId="alice" participants={participants} items={items} />)
    expect(screen.getByText('Assigned to: Alice, Ben')).toBeInTheDocument()
    expect(screen.getByText('Shared by 2, RM 5.00 to RM 5.01 each')).toBeInTheDocument()
  })

  describe('with an amount paid different from the items', () => {
    const rice: ClaimItemView = { id: 'i1', description: 'Rice', quantity: 1, totalCents: 1111, assigned: true, claims: [{ userId: 'alice', amountCents: 1111 }] }
    const pork: ClaimItemView = { id: 'i2', description: 'Pork', quantity: 1, totalCents: 1746, assigned: true, claims: [{ userId: 'ben', amountCents: 1746 }] }

    it('shows one discounts line, the amount paid and what each person pays', () => {
      render(<ClaimItemsPage role="participant" currentUserId="alice" participants={participants} items={[rice, pork]} adjustmentCents={-357} totalCents={2500} />)
      const shares = screen.getByRole('list', { name: 'Each person’s share' })
      expect(within(shares).getByText('Items RM 11.11 → pays RM 9.72')).toBeInTheDocument()
      expect(within(shares).getByText('RM 9.72')).toBeInTheDocument()
      expect(within(shares).getByText('Items RM 17.46 → pays RM 15.28')).toBeInTheDocument()
      expect(screen.getByText('Discounts, tax and rounding').parentElement).toHaveTextContent('−RM 3.57')
      expect(screen.getByText('Amount paid').parentElement).toHaveTextContent('RM 25.00')
    })

    it('waits for every item to have someone before showing what each person pays', () => {
      const open = { ...pork, assigned: false, claims: [] }
      render(<ClaimItemsPage role="participant" currentUserId="alice" participants={participants} items={[rice, open]} adjustmentCents={-357} totalCents={2500} />)
      expect(screen.getByText('What each person pays, discounts and tax included, appears once every item has someone.')).toBeInTheDocument()
      expect(screen.queryByText(/→ pays/)).not.toBeInTheDocument()
      expect(within(screen.getByRole('list', { name: 'Each person’s share' })).getByText('RM 11.11')).toBeInTheDocument()
    })
  })

  it('is read-only on a settled event: no claim, assign or close actions, and a settled note', () => {
    render(<ClaimItemsPage role="owner" currentUserId="alice" participants={participants} items={[unclaimed]} settled />)
    expect(screen.getByText('This event is settled. Expenses are now read-only.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
