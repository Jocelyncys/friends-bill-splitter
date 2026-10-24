import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExpenseEditorPage } from './ExpenseEditorPage'
import { ExpenseSaveError } from './expenseRepository'
import '../../i18n'

const saveExpense = vi.fn()
const getEventHome = vi.fn()
const recognizeReceipt = vi.fn()
vi.mock('../ocr/ocrEngine', () => ({ recognizeReceipt: (...args: unknown[]) => recognizeReceipt(...args) }))
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

function renderEditor(entry = '/event/ev-1/expenses/new') {
  render(
    <MemoryRouter initialEntries={[entry]}>
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
  recognizeReceipt.mockReset()
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:receipt'), revokeObjectURL: vi.fn() }))
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

  describe('receipt scan', () => {
    const photo = () => new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })
    const pick = async () => userEvent.upload(await screen.findByLabelText('Scan a receipt'), photo())

    it('opens itemized with a receipt picker when scan=1', async () => {
      renderEditor('/event/ev-1/expenses/new?scan=1')
      const input = await screen.findByLabelText('Scan a receipt')
      expect(input).toHaveAttribute('accept', 'image/*')
      expect(input).toHaveAttribute('capture', 'environment')
    })

    it('disables save while recognizing', async () => {
      recognizeReceipt.mockReturnValue(new Promise(() => {}))
      renderEditor('/event/ev-1/expenses/new?scan=1')
      await pick()
      expect(await screen.findByText(/Loading the text reader/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save expense' })).toBeDisabled()
    })

    it('reviews parsed rows, lets the user edit them, and saves only after Confirm + Save', async () => {
      recognizeReceipt.mockResolvedValue(['NASI LEMAK 12.50', 'TEH O 3.00', 'TOTAL 15.50'])
      saveExpense.mockResolvedValue({ id: 'x' })
      renderEditor('/event/ev-1/expenses/new?scan=1')
      await pick()

      expect(await screen.findByDisplayValue('NASI LEMAK')).toBeInTheDocument()
      expect(screen.getByDisplayValue('12.50')).toBeInTheDocument()
      expect(screen.getByDisplayValue('TEH O')).toBeInTheDocument()
      expect(screen.getByAltText('Receipt photo preview')).toHaveAttribute('src', 'blob:receipt')
      expect(screen.queryByRole('button', { name: 'Save expense' })).not.toBeInTheDocument()

      await userEvent.clear(screen.getByLabelText('Item 2 price'))
      await userEvent.type(screen.getByLabelText('Item 2 price'), '4.00')
      expect(saveExpense).not.toHaveBeenCalled()

      await userEvent.click(screen.getByRole('button', { name: 'Confirm items' }))
      expect(saveExpense).not.toHaveBeenCalled()
      await userEvent.type(screen.getByLabelText('Description'), 'Lunch')
      await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))

      await waitFor(() => expect(saveExpense).toHaveBeenCalledTimes(1))
      expect(saveExpense.mock.calls[0][0]).toMatchObject({
        totalCents: 1650,
        items: [{ description: 'NASI LEMAK', totalCents: 1250 }, { description: 'TEH O', totalCents: 400 }],
      })
    })

    it('announces a failure, keeps the preview and falls back to an empty manual row', async () => {
      recognizeReceipt.mockRejectedValue(new Error('model failed'))
      renderEditor('/event/ev-1/expenses/new?scan=1')
      await pick()

      const note = await screen.findByText('Could not read this receipt. Enter the items by hand.')
      expect(note).toHaveAttribute('aria-live', 'polite')
      expect(screen.getByAltText('Receipt photo preview')).toBeInTheDocument()
      expect(within(screen.getByRole('group', { name: 'Items' })).getByLabelText('Item 1 name')).toHaveValue('')
      expect(screen.getByRole('button', { name: 'Save expense' })).toBeEnabled()
      expect(saveExpense).not.toHaveBeenCalled()
    })
  })
})
