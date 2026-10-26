import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InvitePanel } from './InvitePanel'
import '../../i18n'

const writeText = vi.fn()

function setShare(share: unknown) {
  Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true })
}

beforeEach(() => {
  localStorage.setItem('inviteToken:ev-1', 'tok-1')
  writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  setShare(undefined)
  localStorage.clear()
})

describe('InvitePanel', () => {
  it('shares the invite link with the event name in one tap', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    setShare(share)
    render(<InvitePanel eventId="ev-1" eventName="Penang Trip" />)
    fireEvent.click(screen.getByRole('button', { name: 'Share invite' }))
    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1))
    const data = share.mock.calls[0][0] as ShareData
    expect(data.title).toBe('Penang Trip')
    expect(data.text).toContain('Penang Trip')
    expect(data.url).toContain('#/join/tok-1')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('stays quiet when the share sheet is closed', async () => {
    const share = vi.fn().mockRejectedValue(new DOMException('closed', 'AbortError'))
    setShare(share)
    render(<InvitePanel eventId="ev-1" eventName="Penang Trip" />)
    fireEvent.click(screen.getByRole('button', { name: 'Share invite' }))
    await vi.waitFor(() => expect(share).toHaveBeenCalled())
    await Promise.resolve()
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByText('Copied')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('copies the link when sharing is not available', async () => {
    render(<InvitePanel eventId="ev-1" eventName="Penang Trip" />)
    fireEvent.click(screen.getByRole('button', { name: 'Share invite' }))
    expect(await screen.findByText('Copied')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('#/join/tok-1'))
  })

  it('copies the link when sharing fails for another reason', async () => {
    setShare(vi.fn().mockRejectedValue(new DOMException('nope', 'NotAllowedError')))
    render(<InvitePanel eventId="ev-1" eventName="Penang Trip" />)
    fireEvent.click(screen.getByRole('button', { name: 'Share invite' }))
    expect(await screen.findByText('Copied')).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('#/join/tok-1'))
  })

  it('keeps the link field and copy button as a fallback', async () => {
    render(<InvitePanel eventId="ev-1" eventName="Penang Trip" />)
    expect(screen.getByLabelText<HTMLInputElement>('Invite link').value).toContain('#/join/tok-1')
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
})
