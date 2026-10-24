import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EventHomePage } from './EventHomePage'
import '../../i18n'

describe('EventHomePage', () => {
  it('shows large guided actions for an empty event', () => {
    render(<EventHomePage eventName="Penang Trip" expenses={[]} attention={[]} />)
    expect(screen.getByRole('button', { name: /scan a receipt/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add simple expense/i })).toBeInTheDocument()
  })

  it('shows compact actions, attention, and recent expenses for an active event', () => {
    render(<EventHomePage eventName="Penang Trip" expenses={[{ id: '1', description: 'Petrol', totalCents: 9000 }]} attention={['Claim lunch items']} />)
    expect(screen.getByText('Claim lunch items')).toBeInTheDocument()
    expect(screen.getByText('Petrol')).toBeInTheDocument()
  })
})

describe('EventHomePage settlement entry points', () => {
  const expenses = [{ id: '1', description: 'Petrol', totalCents: 9000 }]

  it('offers Settle now to managers of an open event', () => {
    render(<EventHomePage eventName="Trip" expenses={expenses} attention={[]} onSettle={() => undefined} />)
    expect(screen.getByRole('button', { name: /^.{0,3}Settle now$/ })).toBeInTheDocument()
  })

  it('does not offer Settle now without the handler', () => {
    render(<EventHomePage eventName="Trip" expenses={expenses} attention={[]} />)
    expect(screen.queryByRole('button', { name: /Settle now/ })).not.toBeInTheDocument()
  })

  it('shows View payments and hides add/scan once settled', () => {
    render(<EventHomePage eventName="Trip" expenses={expenses} attention={[]} settled onSettle={() => undefined} onViewPayments={() => undefined} />)
    expect(screen.getByRole('button', { name: /View payments/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /scan a receipt/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add simple expense/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Settle now/ })).not.toBeInTheDocument()
  })
})
