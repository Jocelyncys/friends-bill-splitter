import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateEventPage } from './CreateEventPage'
import { InvitePanel } from './InvitePanel'
import i18n from '../../i18n'

const createEvent = vi.fn()
vi.mock('./eventRepository', () => ({ createEventRepository: () => ({ createEvent }) }))
vi.mock('../auth/anonymousSession', () => ({ ensureAnonymousSession: vi.fn().mockResolvedValue('user-1') }))

beforeEach(() => {
  vi.useRealTimers()
  createEvent.mockReset()
  createEvent.mockResolvedValue({ eventId: 'ev-9', inviteToken: 'tok-abc' })
})

describe('CreateEventPage', () => {
  it('creates the event, stores the invite token and navigates to the event', async () => {
    localStorage.setItem('preferredName', 'Joc')
    render(
      <MemoryRouter initialEntries={['/new/trip_event']}>
        <Routes>
          <Route path="/new/:mode" element={<CreateEventPage />} />
          <Route path="/event/:eventId" element={<p>event home</p>} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Your name')).toHaveValue('Joc')
    await userEvent.type(screen.getByLabelText('Event name'), 'Penang Trip')
    await userEvent.click(screen.getByRole('button', { name: 'Create event' }))

    expect(await screen.findByText('event home')).toBeInTheDocument()
    expect(createEvent).toHaveBeenCalledWith({ name: 'Penang Trip', mode: 'trip_event', currency: 'MYR', displayName: 'Joc' })
    expect(localStorage.getItem('inviteToken:ev-9')).toBe('tok-abc')
  })

  it('still navigates and shows the invite link once with a warning when it cannot be stored', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    function Landing() {
      const state = useLocation().state as { unsavedInviteToken?: string } | null
      return <InvitePanel eventId="ev-9" eventName="Dinner" token={state?.unsavedInviteToken} />
    }
    try {
      render(
        <MemoryRouter initialEntries={['/new/single_bill']}>
          <Routes>
            <Route path="/new/:mode" element={<CreateEventPage />} />
            <Route path="/event/:eventId" element={<Landing />} />
          </Routes>
        </MemoryRouter>,
      )
      await userEvent.type(screen.getByLabelText('Event name'), 'Dinner')
      await userEvent.type(screen.getByLabelText('Your name'), 'Joc')
      await userEvent.click(screen.getByRole('button', { name: 'Create event' }))
      expect((await screen.findByLabelText<HTMLInputElement>('Invite link')).value).toContain('#/join/tok-abc')
      expect(screen.getByRole('alert')).toHaveTextContent('could not be saved on this device')
    } finally {
      setItem.mockRestore()
    }
  })

  function renderCreate(mode: string) {
    return render(
      <MemoryRouter initialEntries={[`/new/${mode}`]}>
        <Routes>
          <Route path="/new/:mode" element={<CreateEventPage />} />
          <Route path="/event/:eventId" element={<p>event home</p>} />
          <Route path="/event/:eventId/expenses/new" element={<p>receipt scan</p>} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('uses a dated default name when the event name is left blank', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 26, 12))
    localStorage.setItem('preferredName', 'Joc')
    renderCreate('single_bill')
    expect(screen.getByLabelText('Event name')).toHaveAttribute('placeholder', 'Bill 26 Oct')
    await userEvent.click(screen.getByRole('button', { name: 'Create event' }))
    expect(await screen.findByText('receipt scan')).toBeInTheDocument()
    expect(createEvent).toHaveBeenCalledWith({ name: 'Bill 26 Oct', mode: 'single_bill', currency: 'MYR', displayName: 'Joc' })
  })

  it('names a blank trip in the current language', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 9, 26, 12))
    localStorage.setItem('preferredName', 'Joc')
    await i18n.changeLanguage('zh-CN')
    try {
      renderCreate('trip_event')
      expect(screen.getByLabelText('活动名称')).toHaveAttribute('placeholder', '旅行 10月26日')
      await userEvent.click(screen.getByRole('button', { name: '创建活动' }))
      expect(await screen.findByText('event home')).toBeInTheDocument()
      expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ name: '旅行 10月26日', mode: 'trip_event' }))
    } finally {
      await i18n.changeLanguage('en')
    }
  })

  function Where({ label }: { label: string }) {
    const location = useLocation()
    const navigate = useNavigate()
    const state = location.state as { showInvite?: boolean } | null
    return (
      <>
        <p>{`${label} ${location.pathname}${location.search}${state?.showInvite ? ' invite open' : ''}`}</p>
        <button type="button" onClick={() => void navigate(-1)}>go back</button>
      </>
    )
  }
  function renderFlow(mode: string) {
    localStorage.setItem('preferredName', 'Joc')
    render(
      <MemoryRouter initialEntries={['/', `/new/${mode}`]} initialIndex={1}>
        <Routes>
          <Route path="/" element={<p>start</p>} />
          <Route path="/new/:mode" element={<CreateEventPage />} />
          <Route path="/event/:eventId" element={<Where label="home" />} />
          <Route path="/event/:eventId/expenses/new" element={<Where label="editor" />} />
        </Routes>
      </MemoryRouter>,
    )
  }

  it('starts a single bill at the receipt scan, with the event home one step back', async () => {
    renderFlow('single_bill')
    await userEvent.click(screen.getByRole('button', { name: 'Create event' }))
    expect(await screen.findByText('editor /event/ev-9/expenses/new?scan=1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'go back' }))
    expect(await screen.findByText('home /event/ev-9')).toBeInTheDocument()
  })

  it('starts a trip at the event home with the invite open', async () => {
    renderFlow('trip_event')
    await userEvent.click(screen.getByRole('button', { name: 'Create event' }))
    expect(await screen.findByText('home /event/ev-9 invite open')).toBeInTheDocument()
  })

  it('still requires your name', async () => {
    localStorage.setItem('preferredName', '')
    renderCreate('trip_event')
    await userEvent.click(screen.getByRole('button', { name: 'Create event' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Please enter your name.')
    expect(createEvent).not.toHaveBeenCalled()
  })
})
