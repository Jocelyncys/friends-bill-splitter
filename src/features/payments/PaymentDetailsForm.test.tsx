import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'

const mocks = vi.hoisted(() => ({
  saveMyPaymentDetails: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
  forget: vi.fn(),
}))
vi.mock('./paymentRepository', () => ({ createPaymentRepository: () => ({ saveMyPaymentDetails: mocks.saveMyPaymentDetails }) }))
vi.mock('./paymentPrefs', () => ({ paymentPrefs: { load: mocks.load, save: mocks.save, forget: mocks.forget } }))

import { PaymentDetailsForm } from './PaymentDetailsForm'

async function fillBank() {
  await userEvent.type(screen.getByLabelText('Bank name'), 'Maybank')
  await userEvent.type(screen.getByLabelText('Account holder name'), 'Ben Tan')
  await userEvent.type(screen.getByLabelText('Account number'), '1234567890')
}

describe('PaymentDetailsForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.load.mockResolvedValue(null)
    mocks.saveMyPaymentDetails.mockResolvedValue(undefined)
    mocks.save.mockResolvedValue(undefined)
    mocks.forget.mockResolvedValue(undefined)
  })

  it('refuses to save when no method is given', async () => {
    render(<PaymentDetailsForm eventId="e1" userId="ben" />)
    await userEvent.click(screen.getByRole('button', { name: 'Save details' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Add a QR image, or the bank name')
    expect(mocks.saveMyPaymentDetails).not.toHaveBeenCalled()
  })

  it('saves bank details to the event and does not remember them by default', async () => {
    render(<PaymentDetailsForm eventId="e1" userId="ben" />)
    await fillBank()
    await userEvent.click(screen.getByRole('button', { name: 'Save details' }))
    expect(mocks.saveMyPaymentDetails).toHaveBeenCalledWith(
      'e1',
      { preferredMethod: 'bank', bankName: 'Maybank', accountHolderName: 'Ben Tan', accountNumber: '1234567890', paymentReference: null },
      undefined,
    )
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('remembers the details under the user id when asked, with a warning shown', async () => {
    render(<PaymentDetailsForm eventId="e1" userId="ben" />)
    expect(screen.getByText(/unlocked browser profile/)).toBeInTheDocument()
    await fillBank()
    await userEvent.click(screen.getByRole('checkbox', { name: 'Remember these payment details on this device' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save details' }))
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ userId: 'ben', bankName: 'Maybank', accountNumber: '1234567890', qr: null }))
  })

  it('prefills from the remembered copy and can forget it', async () => {
    mocks.load.mockResolvedValue({ userId: 'ben', preferredMethod: 'bank', bankName: 'CIMB', accountHolderName: 'Ben', accountNumber: '99998888', paymentReference: null, qr: null })
    render(<PaymentDetailsForm eventId="e1" userId="ben" />)
    expect(await screen.findByDisplayValue('CIMB')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Remember these payment details on this device' })).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'Forget my payment details' }))
    expect(mocks.forget).toHaveBeenCalledWith('ben')
    expect(screen.queryByRole('button', { name: 'Forget my payment details' })).not.toBeInTheDocument()
  })

  it('offers no forget button when nothing is remembered', () => {
    render(<PaymentDetailsForm eventId="e1" userId="ben" />)
    expect(screen.queryByRole('button', { name: 'Forget my payment details' })).not.toBeInTheDocument()
  })

  it('rejects an oversized QR image', async () => {
    render(<PaymentDetailsForm eventId="e1" userId="ben" />)
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'qr.png', { type: 'image/png' })
    await userEvent.upload(screen.getByLabelText(/Payment QR image/), big)
    await userEvent.click(screen.getByRole('button', { name: 'Save details' }))
    expect(screen.getByRole('alert')).toHaveTextContent('5 MB')
    expect(mocks.saveMyPaymentDetails).not.toHaveBeenCalled()
  })

  it('asks for confirmation before changing details after a payment was sent', async () => {
    render(<PaymentDetailsForm eventId="e1" userId="ben" warnBeforeSave />)
    await fillBank()
    await userEvent.click(screen.getByRole('button', { name: 'Save details' }))
    expect(mocks.saveMyPaymentDetails).not.toHaveBeenCalled()
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save changes' }))
    expect(mocks.saveMyPaymentDetails).toHaveBeenCalledOnce()
  })
})
