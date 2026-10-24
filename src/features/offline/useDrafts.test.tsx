import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExpenseDraft } from './draftDb'
import '../../i18n'

const db = vi.hoisted(() => ({
  listDrafts: vi.fn(),
  subscribeDrafts: vi.fn(() => () => undefined),
  deleteDraft: vi.fn(),
}))
vi.mock('./draftDb', () => db)

import { DraftList } from './DraftList'
import { useUnsyncedWarning } from './useDrafts'

const draft = (status: ExpenseDraft['status'], errorCode?: string): ExpenseDraft => ({
  id: 'd1',
  eventId: 'e1',
  status,
  errorCode,
  updatedAt: 1,
  payload: {
    id: 'd1',
    eventId: 'e1',
    payerUserId: 'u',
    description: 'Dinner',
    expenseDate: '2026-10-25',
    totalCents: 1250,
    splitMethod: 'equal',
    items: [],
    allocations: [{ itemId: null, participantUserId: 'u', amountCents: 1250 }],
  },
})

function Warn() {
  useUnsyncedWarning()
  return null
}

type Spy = { mock: { calls: unknown[][] } }

describe('useUnsyncedWarning', () => {
  let add: Spy
  let remove: Spy
  beforeEach(() => {
    add = vi.spyOn(window, 'addEventListener')
    remove = vi.spyOn(window, 'removeEventListener')
  })
  afterEach(() => vi.restoreAllMocks())
  const unloadCalls = (spy: Spy) => spy.mock.calls.filter(call => call[0] === 'beforeunload')

  it('registers beforeunload only while unsynced drafts exist', async () => {
    db.listDrafts.mockResolvedValue([draft('pending')])
    const { unmount } = render(<Warn />)
    await waitFor(() => expect(unloadCalls(add)).toHaveLength(1))
    unmount()
    expect(unloadCalls(remove)).toHaveLength(1)
  })

  it('stays quiet with no drafts, or when IndexedDB is unavailable', async () => {
    db.listDrafts.mockResolvedValueOnce([])
    const first = render(<Warn />)
    await Promise.resolve()
    first.unmount()
    db.listDrafts.mockRejectedValueOnce(new Error('no idb'))
    render(<Warn />)
    await Promise.resolve()
    expect(unloadCalls(add)).toHaveLength(0)
  })
})

describe('DraftList', () => {
  const renderList = () =>
    render(
      <MemoryRouter>
        <DraftList eventId="e1" currency="MYR" />
      </MemoryRouter>,
    )
  beforeEach(() => vi.clearAllMocks())

  it('labels a pending draft and warns not to clear browser data', async () => {
    db.listDrafts.mockResolvedValue([draft('pending')])
    renderList()
    expect(await screen.findByText('Waiting to sync')).toBeInTheDocument()
    expect(screen.getByText(/Don’t clear your browser data/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Discard' })).not.toBeInTheDocument()
  })

  it('shows why a failed draft was refused, lets it be reviewed, and discards only after confirming', async () => {
    db.listDrafts.mockResolvedValue([draft('failed', 'event_not_open')])
    db.deleteDraft.mockResolvedValue(undefined)
    renderList()
    expect(await screen.findByText('Couldn’t sync — review')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('This event is closed')
    expect(screen.getByRole('link', { name: 'Review' })).toHaveAttribute('href', '/event/e1/expenses/new?draft=d1')
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(db.deleteDraft).not.toHaveBeenCalled()
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Discard' }))
    expect(db.deleteDraft).toHaveBeenCalledWith('d1')
  })
})
