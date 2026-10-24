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
