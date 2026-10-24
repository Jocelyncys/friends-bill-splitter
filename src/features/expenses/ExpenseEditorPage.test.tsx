import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExpenseEditorPage } from './ExpenseEditorPage'
import { ExpenseSaveError } from './expenseRepository'
import '../../i18n'

const saveExpense = vi.fn()
const getEventHome = vi.fn()
vi.mock('./expenseRepository', async importOriginal => ({
  ...(await importOriginal<typeof import('./expenseRepository')>()),
  createExpenseRepository: () => ({ saveExpense }),
}))
vi.mock('../events/eventRepository', () => ({ createEventRepository: () => ({ getEventHome }) }))

const home = {
  event: { id: 'ev-1', name: 'Penang Trip', mode: 'trip_event', currency: 'MYR', state: 'open', revision: 1 },
  me: { userId: 'u-a', role: 'participant', displayName: 'Alice' },
  members: [
    { userId: 'u-a', role: 'participant', displayName: 'Alice' },
    { userId: 'u-b', role: 'owner', displayName: 'Bob' },
  ],
  expenses: [],
  groupTotalCents: 0,
  attention: [],
}

function renderEditor() {
  render(
    <MemoryRouter initialEntries={['/event/ev-1/expenses/new']}>
      <Routes>
        <Route path="/event/:eventId/expenses/new" element={<ExpenseEditorPage />} />
        <Route path="/event/:eventId" element={<p>event home</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

async function fillSimple() {
  await userEvent.type(await screen.findByLabelText('Description'), 'Dinner')
  await userEvent.type(screen.getByLabelText('Amount'), '10.01')
}

beforeEach(() => {
  saveExpense.mockReset()
  getEventHome.mockReset()
  getEventHome.mockResolvedValue(home)
})

describe('ExpenseEditorPage', () => {
  it('submits an equal split of a simple expense', async () => {
    saveExpense.mockResolvedValue({ id: 'x' })
    renderEditor()
    await fillSimple()
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))

    expect(await screen.findByText('event home')).toBeInTheDocument()
    expect(saveExpense).toHaveBeenCalledTimes(1)
    const payload = saveExpense.mock.calls[0][0]
    expect(payload).toMatchObject({
      eventId: 'ev-1',
      payerUserId: 'u-a',
      description: 'Dinner',
      totalCents: 1001,
      splitMethod: 'equal',
      items: [],
      allocations: [
        { itemId: null, participantUserId: 'u-a', amountCents: 501 },
        { itemId: null, participantUserId: 'u-b', amountCents: 500 },
      ],
    })
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('shows a translated message for allocation_mismatch', async () => {
    saveExpense.mockRejectedValue(new ExpenseSaveError({ field: 'allocations', code: 'allocation_mismatch' }, new Error('x')))
    renderEditor()
    await fillSimple()
    await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The split does not add up to the total.')
  })
})
