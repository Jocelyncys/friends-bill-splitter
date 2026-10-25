import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExpenseEditorPage } from './ExpenseEditorPage'
import { ExpenseSaveError } from './expenseRepository'
import '../../i18n'

const saveExpense = vi.fn()
const getExpense = vi.fn()
const deleteExpense = vi.fn()
const getEventHome = vi.fn()
const recognizeReceipt = vi.fn()
const saveDraft = vi.fn()
const getDraft = vi.fn()
const deleteDraft = vi.fn()
vi.mock('../offline/draftDb', () => ({
  saveDraft: (...args: unknown[]) => saveDraft(...args),
  getDraft: (...args: unknown[]) => getDraft(...args),
  deleteDraft: (...args: unknown[]) => deleteDraft(...args),
}))
vi.mock('../ocr/ocrEngine', () => ({ recognizeReceipt: (...args: unknown[]) => recognizeReceipt(...args) }))
vi.mock('./expenseRepository', async importOriginal => ({
  ...(await importOriginal<typeof import('./expenseRepository')>()),
  createExpenseRepository: () => ({ saveExpense, getExpense, deleteExpense }),
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
        <Route path="/event/:eventId/expenses/:expenseId/edit" element={<ExpenseEditorPage />} />
        <Route path="/event/:eventId/expenses" element={<p>expense list</p>} />
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
  getExpense.mockReset()
  deleteExpense.mockReset()
  getEventHome.mockReset()
  recognizeReceipt.mockReset()
  saveDraft.mockReset().mockResolvedValue(undefined)
  getDraft.mockReset()
  deleteDraft.mockReset().mockResolvedValue(undefined)
  URL.createObjectURL = vi.fn()
  URL.revokeObjectURL = vi.fn()
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:receipt')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  getEventHome.mockResolvedValue(home)
})

afterEach(() => {
  vi.restoreAllMocks()
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

  describe('offline drafts', () => {
    const save = () => userEvent.click(screen.getByRole('button', { name: 'Save expense' }))

    it('saves a draft on this device instead of calling the server while offline', async () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
      renderEditor()
      expect(await screen.findByText(/You are offline/)).toBeInTheDocument()
      await fillSimple()
      await save()
      expect(await screen.findByText('event home')).toBeInTheDocument()
      expect(saveExpense).not.toHaveBeenCalled()
      expect(saveDraft).toHaveBeenCalledTimes(1)
      expect(saveDraft.mock.calls[0][0]).toMatchObject({ eventId: 'ev-1', description: 'Dinner', totalCents: 1001, splitMethod: 'equal' })
    })

    it('keeps a draft when the network fails mid-save, with the same id the server saw', async () => {
      saveExpense.mockRejectedValue(new TypeError('Failed to fetch'))
      renderEditor()
      await fillSimple()
      await save()
      expect(await screen.findByText('event home')).toBeInTheDocument()
      expect(saveDraft.mock.calls[0][0].id).toBe(saveExpense.mock.calls[0][0].id)
    })

    it('keeps a draft when the repository reports a network_error', async () => {
      saveExpense.mockRejectedValue(new ExpenseSaveError({ code: 'network_error' }, new Error('x')))
      renderEditor()
      await fillSimple()
      await save()
      expect(await screen.findByText('event home')).toBeInTheDocument()
      expect(saveDraft).toHaveBeenCalledTimes(1)
    })

    it('shows a persistent server failure (save_failed) as an error instead of waiting to sync', async () => {
      saveExpense.mockRejectedValue(new ExpenseSaveError({ code: 'save_failed' }, new Error('x')))
      renderEditor()
      await fillSimple()
      await save()
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the expense. Please try again.')
      expect(saveDraft).not.toHaveBeenCalled()
    })

    it('does not keep a draft when the server rejects the expense', async () => {
      saveExpense.mockRejectedValue(new ExpenseSaveError({ code: 'event_not_open' }, new Error('x')))
      renderEditor()
      await fillSimple()
      await save()
      expect(await screen.findByRole('alert')).toHaveTextContent('This event is closed')
      expect(saveDraft).not.toHaveBeenCalled()
    })

    it('says so when the draft cannot be stored on this device', async () => {
      vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
      saveDraft.mockRejectedValue(new Error('quota'))
      renderEditor()
      await fillSimple()
      await save()
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the expense on this device')
    })

    it('reopens a failed draft prefilled, resends it with the same id and removes it', async () => {
      getDraft.mockResolvedValue({
        id: 'draft-9',
        eventId: 'ev-1',
        status: 'failed',
        updatedAt: 1,
        payload: {
          id: 'draft-9',
          eventId: 'ev-1',
          payerUserId: 'u-a',
          description: 'Lunch',
          expenseDate: '2026-10-20',
          totalCents: 2000,
          splitMethod: 'equal',
          items: [],
          allocations: [
            { itemId: null, participantUserId: 'u-a', amountCents: 1000 },
            { itemId: null, participantUserId: 'u-b', amountCents: 1000 },
          ],
        },
      })
      saveExpense.mockResolvedValue({ id: 'draft-9' })
      renderEditor('/event/ev-1/expenses/new?draft=draft-9')
      expect(await screen.findByLabelText('Description')).toHaveValue('Lunch')
      expect(screen.getByLabelText('Amount')).toHaveValue('20.00')
      await save()
      expect(await screen.findByText('event home')).toBeInTheDocument()
      expect(saveExpense).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft-9', totalCents: 2000 }))
      expect(deleteDraft).toHaveBeenCalledWith('draft-9')
    })
  })

  describe('receipt scan', () => {
    const photo = () => new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })
    const pick = async () => userEvent.upload(await screen.findByLabelText(/Scan a receipt|Choose receipt photo/), photo())

    it('opens itemized with a receipt picker when scan=1', async () => {
      renderEditor('/event/ev-1/expenses/new?scan=1')
      const input = await screen.findByLabelText('Scan a receipt')
      expect(input).toHaveAttribute('accept', 'image/*')
      expect(input).not.toHaveAttribute('capture')
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

    it('lets the user save again after switching away from itemized during review', async () => {
      recognizeReceipt.mockResolvedValue(['TEH O 3.00'])
      renderEditor('/event/ev-1/expenses/new?scan=1')
      await pick()
      await screen.findByRole('button', { name: 'Confirm items' })
      await userEvent.selectOptions(screen.getByLabelText('Split method'), 'equal')
      expect(screen.getByRole('button', { name: 'Save expense' })).toBeEnabled()
    })

    it('cancels an in-flight scan when switching away from itemized', async () => {
      let finish: (lines: string[]) => void = () => {}
      recognizeReceipt.mockReturnValue(new Promise<string[]>(r => { finish = r }))
      renderEditor('/event/ev-1/expenses/new?scan=1')
      await pick()
      await userEvent.selectOptions(screen.getByLabelText('Split method'), 'equal')
      expect(screen.getByRole('button', { name: 'Save expense' })).toBeEnabled()
      finish(['TEH O 3.00'])
      await userEvent.selectOptions(screen.getByLabelText('Split method'), 'items')
      expect(screen.queryByDisplayValue('TEH O')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Save expense' })).toBeEnabled()
    })

    it('does not wipe rows the user already typed', async () => {
      recognizeReceipt.mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(['TEH O 3.00'])
      renderEditor('/event/ev-1/expenses/new?scan=1')
      await userEvent.type(await screen.findByLabelText('Item 1 name'), 'Kopi')
      await pick()
      await screen.findByText('Could not read this receipt. Enter the items by hand.')
      expect(screen.getByLabelText('Item 1 name')).toHaveValue('Kopi')
      await pick()
      expect(await screen.findByDisplayValue('TEH O')).toBeInTheDocument()
      expect(screen.getByDisplayValue('Kopi')).toBeInTheDocument()
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

it('has exactly one field labelled "Amount" (the split-method select must not match via its options)', async () => {
  renderEditor()
  await screen.findByLabelText('Description')
  expect(screen.getAllByLabelText('Amount')).toHaveLength(1)
  expect(screen.getAllByLabelText(/amount/i)).toEqual([screen.getByRole('textbox', { name: 'Amount' })])
  expect(screen.getByLabelText('Split method').tagName).toBe('SELECT')
})

describe('ExpenseEditorPage (saved expense)', () => {
  describe('editing a saved expense', () => {
    const equalSaved = {
      creatorUserId: 'u-a',
      claims: {},
      payload: {
        id: 'x-1', eventId: 'ev-1', payerUserId: 'u-a', description: 'Dinner', category: 'food', expenseDate: '2026-10-20',
        totalCents: 1000, splitMethod: 'equal', items: [],
        allocations: [
          { itemId: null, participantUserId: 'u-a', amountCents: 500 },
          { itemId: null, participantUserId: 'u-b', amountCents: 500 },
        ],
      },
    }

    it('prefills the form and saves with the same id and category', async () => {
      getExpense.mockResolvedValue(equalSaved)
      saveExpense.mockResolvedValue({ id: 'x-1' })
      renderEditor('/event/ev-1/expenses/x-1/edit')
      expect(await screen.findByRole('heading', { name: 'Edit expense' })).toBeInTheDocument()
      expect(screen.getByLabelText('Description')).toHaveValue('Dinner')
      expect(screen.getByLabelText('Amount')).toHaveValue('10.00')
      expect(screen.getByLabelText('Date')).toHaveValue('2026-10-20')
      await userEvent.clear(screen.getByLabelText('Amount'))
      await userEvent.type(screen.getByLabelText('Amount'), '12')
      await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))

      expect(await screen.findByText('expense list')).toBeInTheDocument()
      expect(getExpense).toHaveBeenCalledWith('x-1')
      expect(saveExpense.mock.calls[0][0]).toMatchObject({
        id: 'x-1',
        category: 'food',
        totalCents: 1200,
        allocations: [
          { itemId: null, participantUserId: 'u-a', amountCents: 600 },
          { itemId: null, participantUserId: 'u-b', amountCents: 600 },
        ],
      })
    })

    it('shows self-claims read-only and sends no allocations for claimed items', async () => {
      getExpense.mockResolvedValue({
        creatorUserId: 'u-a',
        claims: { 'it-1': ['u-b'] },
        payload: {
          id: 'x-2', eventId: 'ev-1', payerUserId: 'u-a', description: 'Hawker', category: 'other', expenseDate: '2026-10-20',
          totalCents: 1500, splitMethod: 'item_claim',
          items: [
            { id: 'it-1', description: 'Rice', quantity: 1, totalCents: 1000, sortOrder: 0 },
            { id: 'it-2', description: 'Tea', quantity: 1, totalCents: 500, sortOrder: 1 },
          ],
          allocations: [],
        },
      })
      saveExpense.mockResolvedValue({ id: 'x-2' })
      renderEditor('/event/ev-1/expenses/x-2/edit')
      expect(await screen.findByText('Claimed by: Bob')).toBeInTheDocument()
      await userEvent.clear(screen.getByLabelText('Item 2 price'))
      await userEvent.type(screen.getByLabelText('Item 2 price'), '6')
      await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
      expect(await screen.findByText('expense list')).toBeInTheDocument()
      expect(saveExpense.mock.calls[0][0]).toMatchObject({ id: 'x-2', splitMethod: 'item_claim', totalCents: 1600, allocations: [] })
    })

    it('deletes after confirmation', async () => {
      getExpense.mockResolvedValue(equalSaved)
      deleteExpense.mockResolvedValue(undefined)
      renderEditor('/event/ev-1/expenses/x-1/edit')
      await userEvent.click(await screen.findByRole('button', { name: 'Delete expense' }))
      const dialog = screen.getByRole('dialog', { name: 'Delete this expense?' })
      expect(deleteExpense).not.toHaveBeenCalled()
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
      expect(await screen.findByText('expense list')).toBeInTheDocument()
      expect(deleteExpense).toHaveBeenCalledWith('x-1')
    })

    it('keeps the expense when the delete is cancelled and shows a server refusal', async () => {
      getExpense.mockResolvedValue(equalSaved)
      deleteExpense.mockRejectedValue(new ExpenseSaveError({ code: 'event_not_open' }, null))
      renderEditor('/event/ev-1/expenses/x-1/edit')
      await userEvent.click(await screen.findByRole('button', { name: 'Delete expense' }))
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Back' }))
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Delete expense' }))
      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
      expect(await screen.findByRole('alert')).toHaveTextContent('This event is closed')
      expect(deleteExpense).toHaveBeenCalledTimes(1)
    })

    it("does not open another person's expense for a participant", async () => {
      getExpense.mockResolvedValue({ ...equalSaved, creatorUserId: 'u-b' })
      renderEditor('/event/ev-1/expenses/x-1/edit')
      expect(await screen.findByRole('alert')).toHaveTextContent('You are not allowed to change this expense.')
      expect(screen.queryByRole('button', { name: /Save expense|Delete expense/ })).not.toBeInTheDocument()
    })

    it('is read-only on a settled event when editing', async () => {
      getEventHome.mockResolvedValue({ ...home, event: { ...home.event, state: 'settled' } })
      getExpense.mockResolvedValue(equalSaved)
      renderEditor('/event/ev-1/expenses/x-1/edit')
      expect(await screen.findByText('This event is settled. Expenses are now read-only.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Save expense|Delete expense/ })).not.toBeInTheDocument()
    })

    it('does not offer a new expense form on a settled event', async () => {
      getEventHome.mockResolvedValue({ ...home, event: { ...home.event, state: 'settled' } })
      renderEditor()
      expect(await screen.findByText('This event is settled. Expenses are now read-only.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Save expense' })).not.toBeInTheDocument()
    })
  })
})
