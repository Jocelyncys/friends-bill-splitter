import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ClaimItemsPage, type ClaimItemView } from './ClaimItemsPage'
import '../../i18n'

const participants = [{ id: 'alice', name: 'Alice' }, { id: 'ben', name: 'Ben' }]
const unclaimed: ClaimItemView = { id: 'i1', description: 'Satay', quantity: 1, totalCents: 1001, claims: [], assigned: false }

describe('ClaimItemsPage', () => {
  it('lets a participant claim for themselves but not assign another person', async () => {
    render(<ClaimItemsPage role="participant" currentUserId="alice" participants={[{ id: 'alice', name: 'Alice' }, { id: 'ben', name: 'Ben' }]} items={[unclaimed]} />)
    expect(screen.getByRole('button', { name: 'Claim for me' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Assign to Ben' })).not.toBeInTheDocument()
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

  it('gives managers per-member assign buttons and a close/reopen toggle', async () => {
    const onAssign = vi.fn()
    const onToggleClosed = vi.fn()
    render(
      <ClaimItemsPage role="cohost" currentUserId="alice" canManage participants={participants} items={[unclaimed]}
        onAssign={onAssign} onToggleClosed={onToggleClosed} />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Assign to Ben' }))
    expect(onAssign).toHaveBeenCalledWith('i1', 'ben')
    await userEvent.click(screen.getByRole('button', { name: 'Close claiming' }))
    expect(onToggleClosed).toHaveBeenCalledWith(true)
  })

  it('disables claiming when closed (managers can still assign) and offers reopen', () => {
    render(<ClaimItemsPage role="owner" currentUserId="alice" claimingClosed participants={participants} items={[unclaimed]} />)
    expect(screen.getByRole('button', { name: 'Claim for me' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Assign to Ben' })).toBeEnabled()
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
    expect(screen.getByRole('button', { name: 'Assign to Ben' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close claiming' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Claiming is closed.')
  })

  it('is read-only on a settled event: no claim, assign or close actions, and a settled note', () => {
    render(<ClaimItemsPage role="owner" currentUserId="alice" participants={participants} items={[unclaimed]} settled />)
    expect(screen.getByText('This event is settled. Expenses are now read-only.')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
