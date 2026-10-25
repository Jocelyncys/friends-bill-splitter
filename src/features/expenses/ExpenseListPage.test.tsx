import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventHome } from '../events/eventRepository'
import type { ExpenseSummary } from './expenseRepository'
import '../../i18n'

const mocks = vi.hoisted(() => ({ getEventHome: vi.fn(), listExpenses: vi.fn() }))
vi.mock('../events/eventRepository', () => ({ createEventRepository: () => ({ getEventHome: mocks.getEventHome }) }))
vi.mock('./expenseRepository', () => ({ createExpenseRepository: () => ({ listExpenses: mocks.listExpenses }) }))
vi.mock('../offline/DraftList', () => ({ DraftList: () => null }))

import { ExpenseListPage } from './ExpenseListPage'

const expenses: ExpenseSummary[] = [
  { id: 'x-mine', description: 'Mine', totalCents: 1000, payerUserId: 'p', creatorUserId: 'p', splitMethod: 'equal', createdAt: '2026-10-24T10:00:00Z' },
  { id: 'x-other', description: 'Other', totalCents: 500, payerUserId: 'q', creatorUserId: 'q', splitMethod: 'equal', createdAt: '2026-10-24T09:00:00Z' },
]

function home(meRole: 'owner' | 'participant', state: 'open' | 'settled' = 'open'): EventHome {
  const members = [
    { userId: 'p', displayName: 'Pat', role: meRole },
    { userId: 'q', displayName: 'Quinn', role: meRole === 'owner' ? ('participant' as const) : ('owner' as const) },
  ]
  return {
    event: { id: 'e1', name: 'Trip', mode: 'trip_event', currency: 'MYR', state, revision: 1 },
    me: members[0],
    members,
    expenses,
    groupTotalCents: 1500,
    attention: [],
  }
}

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/event/e1/expenses']}>
      <Routes><Route path="/event/:eventId/expenses" element={<ExpenseListPage />} /></Routes>
    </MemoryRouter>,
  )
}

describe('ExpenseListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listExpenses.mockResolvedValue(expenses)
  })

  it('offers Edit only on expenses the participant created', async () => {
    mocks.getEventHome.mockResolvedValue(home('participant'))
    renderPage()
    expect(await screen.findByRole('link', { name: 'Edit Mine' })).toHaveAttribute('href', '/event/e1/expenses/x-mine/edit')
    expect(screen.queryByRole('link', { name: 'Edit Other' })).not.toBeInTheDocument()
  })

  it('offers Edit on every expense to the owner', async () => {
    mocks.getEventHome.mockResolvedValue(home('owner'))
    renderPage()
    expect(await screen.findByRole('link', { name: 'Edit Mine' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Edit Other' })).toBeInTheDocument()
  })

  it('has no write actions on a settled event and says it is settled', async () => {
    mocks.getEventHome.mockResolvedValue(home('owner', 'settled'))
    renderPage()
    expect(await screen.findByText('This event is settled. Expenses are now read-only.')).toBeInTheDocument()
    expect(await screen.findByText('Mine')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Edit|Add expense/ })).not.toBeInTheDocument()
  })
})
