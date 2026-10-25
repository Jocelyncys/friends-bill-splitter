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
    const pick = async () => userEvent.upload(await screen.findByLabelText('Choose photo'), photo())

    it('opens itemized with a gallery picker and a rear-camera picker when scan=1', async () => {
      renderEditor('/event/ev-1/expenses/new?scan=1')
      const choose = await screen.findByLabelText('Choose photo')
      expect(choose).toHaveAttribute('accept', 'image/*')
      expect(choose).not.toHaveAttribute('capture')
      const take = screen.getByLabelText('Take photo')
      expect(take).toHaveAttribute('type', 'file')
      expect(take).toHaveAttribute('accept', 'image/*')
      expect(take).toHaveAttribute('capture', 'environment')
    })

    it('reads a photo from the camera input through the same review flow', async () => {
      recognizeReceipt.mockResolvedValue(['TEH O 3.00'])
      renderEditor('/event/ev-1/expenses/new?scan=1')
      await userEvent.upload(await screen.findByLabelText('Take photo'), photo())
      expect(await screen.findByDisplayValue('TEH O')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Confirm items' })).toBeInTheDocument()
    })

    it('pre-fills the voucher and tax lines of a receipt as adjustments for review', async () => {
      recognizeReceipt.mockResolvedValue(['NASI LEMAK 12.50', 'Voucher -2.00', 'SST 6% 0.63', 'TOTAL 11.13'])
      saveExpense.mockResolvedValue({ id: 'x' })
      renderEditor('/event/ev-1/expenses/new?scan=1')
      await pick()
      expect(await screen.findByDisplayValue('NASI LEMAK')).toBeInTheDocument()
      expect(screen.getByLabelText('Adjustment 1 type')).toHaveValue('discount')
      expect(screen.getByLabelText('Adjustment 1 label')).toHaveValue('Voucher')
      expect(screen.getByLabelText('Adjustment 1 amount')).toHaveValue('2.00')
      expect(screen.getByLabelText('Adjustment 2 type')).toHaveValue('tax')
      expect(screen.getByLabelText('Adjustment 2 amount')).toHaveValue('0.63')
      expect(screen.getByText('Amount paid').parentElement).toHaveTextContent('RM 11.13')
      await userEvent.click(screen.getByRole('button', { name: 'Confirm items' }))
      await userEvent.type(screen.getByLabelText('Description'), 'Breakfast')
      await userEvent.click(screen.getByRole('button', { name: 'Save expense' }))
      await waitFor(() => expect(saveExpense).toHaveBeenCalledTimes(1))
      expect(saveExpense.mock.calls[0][0]).toMatchObject({
        totalCents: 1113,
        adjustments: [
          { kind: 'discount', label: 'Voucher', amountCents: -200, sortOrder: 0 },
          { kind: 'tax', label: 'SST 6%', amountCents: 63, sortOrder: 1 },
        ],
      })
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

describe('ExpenseEditorPage (itemized, several people and adjustments)', () => {
  const save = () => userEvent.click(screen.getByRole('button', { name: 'Save expense' }))

  async function startHostAssign() {
    renderEditor()
    await userEvent.type(await screen.findByLabelText('Description'), 'Dinner')
    await userEvent.selectOptions(screen.getByLabelText('Split method'), 'host_assignment')
  }
  async function fillItem(n: number, name: string, price: string, people: string[]) {
    if (n > 1) await userEvent.click(screen.getByRole('button', { name: 'Add item' }))
    await userEvent.type(screen.getByLabelText(`Item ${n} name`), name)
    await userEvent.type(screen.getByLabelText(`Item ${n} price`), price)
    const who = screen.getByRole('group', { name: `Who had Item ${n}` })
    for (const person of people) await userEvent.click(within(who).getByRole('button', { name: person }))
  }
  async function addAdjustment(n: number, kind: string, label: string, amount: string) {
    await userEvent.click(screen.getByRole('button', { name: 'Add adjustment' }))
    await userEvent.selectOptions(screen.getByLabelText(`Adjustment ${n} type`), kind)
    await userEvent.type(screen.getByLabelText(`Adjustment ${n} label`), label)
    await userEvent.type(screen.getByLabelText(`Adjustment ${n} amount`), amount)
  }

  it('assigns one item to several people and splits it equally', async () => {
    saveExpense.mockResolvedValue({ id: 'x' })
    await startHostAssign()
    await fillItem(1, 'Platter', '8', ['Alice', 'Bob'])
    const who = screen.getByRole('group', { name: 'Who had Item 1' })
    expect(within(who).getByRole('button', { name: 'Alice' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(who).getByRole('button', { name: 'Bob' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Shared by 2, RM 4.00 each')).toBeInTheDocument()
    // Tapping again takes a person off the item.
    await userEvent.click(within(who).getByRole('button', { name: 'Bob' }))
    expect(within(who).getByRole('button', { name: 'Bob' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText(/Shared by/)).not.toBeInTheDocument()
    await userEvent.click(within(who).getByRole('button', { name: 'Bob' }))
    await save()
    await waitFor(() => expect(saveExpense).toHaveBeenCalledTimes(1))
    expect(saveExpense.mock.calls[0][0]).toMatchObject({
      splitMethod: 'host_assignment',
      totalCents: 800,
      allocations: [
        { participantUserId: 'u-a', amountCents: 400 },
        { participantUserId: 'u-b', amountCents: 400 },
      ],
    })
  })

  it('shows an uneven split as a range', async () => {
    await startHostAssign()
    await fillItem(1, 'Platter', '0.05', ['Alice', 'Bob'])
    expect(screen.getByText('Shared by 2, RM 0.02 to RM 0.03 each')).toBeInTheDocument()
  })

  it('reopens a saved item shared by two people with both selected', async () => {
    getExpense.mockResolvedValue({
      creatorUserId: 'u-a',
      claims: {},
      payload: {
        id: 'x-3', eventId: 'ev-1', payerUserId: 'u-a', description: 'Dinner', category: 'food', expenseDate: '2026-10-20',
        totalCents: 800, splitMethod: 'host_assignment',
        items: [{ id: 'it-1', description: 'Platter', quantity: 1, totalCents: 800, sortOrder: 0 }],
        allocations: [
          { itemId: 'it-1', participantUserId: 'u-a', amountCents: 400 },
          { itemId: 'it-1', participantUserId: 'u-b', amountCents: 400 },
        ],
        adjustments: [],
      },
    })
    saveExpense.mockResolvedValue({ id: 'x-3' })
    renderEditor('/event/ev-1/expenses/x-3/edit')
    const who = await screen.findByRole('group', { name: 'Who had Item 1' })
    expect(within(who).getByRole('button', { name: 'Alice' })).toHaveAttribute('aria-pressed', 'true')
    expect(within(who).getByRole('button', { name: 'Bob' })).toHaveAttribute('aria-pressed', 'true')
    await save()
    await waitFor(() => expect(saveExpense).toHaveBeenCalledTimes(1))
    expect(saveExpense.mock.calls[0][0].allocations).toHaveLength(2)
  })

  it('adds a voucher, SST and rounding and saves the amount paid', async () => {
    saveExpense.mockResolvedValue({ id: 'x' })
    await startHostAssign()
    await fillItem(1, 'Rice', '11.11', ['Alice'])
    await fillItem(2, 'Pork', '17.46', ['Bob'])
    await addAdjustment(1, 'discount', 'Voucher', '5')
    await addAdjustment(2, 'tax', 'SST (6%)', '1.41')
    await addAdjustment(3, 'rounding', 'Bill rounding', '0.02')

    expect(within(screen.getByRole('group', { name: 'Bill summary' })).getByText('Items').parentElement).toHaveTextContent('RM 28.57')
    expect(screen.getByText('Amount paid').parentElement).toHaveTextContent('RM 25.00')
    const pays = screen.getByRole('list', { name: 'What each person pays' })
    expect(within(pays).getByText('Items RM 11.11 → pays RM 9.72')).toBeInTheDocument()
    expect(within(pays).getByText('Items RM 17.46 → pays RM 15.28')).toBeInTheDocument()

    await save()
    await waitFor(() => expect(saveExpense).toHaveBeenCalledTimes(1))
    expect(saveExpense.mock.calls[0][0]).toMatchObject({
      totalCents: 2500,
      adjustments: [
        { kind: 'discount', label: 'Voucher', amountCents: -500, sortOrder: 0 },
        { kind: 'tax', label: 'SST (6%)', amountCents: 141, sortOrder: 1 },
        { kind: 'rounding', label: 'Bill rounding', amountCents: 2, sortOrder: 2 },
      ],
    })
  })

  it('lets rounding take money off with the sign toggle, and removes a row', async () => {
    saveExpense.mockResolvedValue({ id: 'x' })
    await startHostAssign()
    await fillItem(1, 'Rice', '10', ['Alice'])
    await addAdjustment(1, 'service', 'Service charge', '1')
    expect(screen.queryByRole('button', { name: 'Subtract adjustment 1' })).not.toBeInTheDocument()
    await addAdjustment(2, 'rounding', 'Rounding', '0.02')
    const sign = screen.getByRole('button', { name: 'Subtract adjustment 2' })
    expect(sign).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(sign)
    expect(sign).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText('Amount paid').parentElement).toHaveTextContent('RM 10.98')
    await userEvent.click(screen.getByRole('button', { name: 'Remove adjustment 1' }))
    expect(screen.getByLabelText('Adjustment 1 label')).toHaveValue('Rounding')
    await save()
    await waitFor(() => expect(saveExpense).toHaveBeenCalledTimes(1))
    expect(saveExpense.mock.calls[0][0]).toMatchObject({
      totalCents: 998,
      adjustments: [{ kind: 'rounding', label: 'Rounding', amountCents: -2, sortOrder: 0 }],
    })
  })

  it('blocks saving an adjustment without a label or amount', async () => {
    await startHostAssign()
    await fillItem(1, 'Rice', '10', ['Alice'])
    await userEvent.click(screen.getByRole('button', { name: 'Add adjustment' }))
    await save()
    expect(await screen.findByText('Each adjustment needs a label (up to 60 characters) and an amount other than 0.')).toBeInTheDocument()
    expect(saveExpense).not.toHaveBeenCalled()
  })

  it('blocks adjustments that leave nothing to pay', async () => {
    await startHostAssign()
    await fillItem(1, 'Rice', '5', ['Alice'])
    await addAdjustment(1, 'discount', 'Voucher', '5')
    await save()
    expect(await screen.findByText('The amount paid must be at least 0.01.')).toBeInTheDocument()
    expect(saveExpense).not.toHaveBeenCalled()
  })

  it('warns before switching to an equal split removes the adjustments', async () => {
    await startHostAssign()
    await fillItem(1, 'Rice', '10', ['Alice'])
    await addAdjustment(1, 'discount', 'Voucher', '2')
    await userEvent.selectOptions(screen.getByLabelText('Split method'), 'equal')
    const dialog = screen.getByRole('dialog', { name: 'Remove the adjustments?' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Back' }))
    expect(screen.getByLabelText('Split method')).toHaveValue('host_assignment')
    expect(screen.getByLabelText('Adjustment 1 label')).toHaveValue('Voucher')

    await userEvent.selectOptions(screen.getByLabelText('Split method'), 'equal')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove adjustments' }))
    expect(screen.getByLabelText('Split method')).toHaveValue('equal')
    expect(screen.getByLabelText('Amount')).toHaveValue('8.00')
    await userEvent.selectOptions(screen.getByLabelText('Split method'), 'host_assignment')
    expect(screen.queryByLabelText('Adjustment 1 label')).not.toBeInTheDocument()
  })

  it('switches between the two itemized methods without a warning and keeps the adjustments', async () => {
    await startHostAssign()
    await fillItem(1, 'Rice', '10', ['Alice'])
    await addAdjustment(1, 'discount', 'Voucher', '2')
    await userEvent.selectOptions(screen.getByLabelText('Split method'), 'items')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Adjustment 1 label')).toHaveValue('Voucher')
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
