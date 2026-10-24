import { describe, expect, it } from 'vitest'
import { MAX_QR_BYTES, paymentDetailsSchema } from './paymentDetailsSchema'

const png = () => new File([new Uint8Array(10)], 'qr.png', { type: 'image/png' })
const bank = { bankName: 'Maybank', accountHolderName: 'Ben Tan', accountNumber: '1234567890' }

describe('paymentDetailsSchema', () => {
  it('accepts a QR image alone', () => {
    const result = paymentDetailsSchema.safeParse({ qrFile: png() })
    expect(result.success).toBe(true)
  })

  it('accepts bank details alone', () => {
    expect(paymentDetailsSchema.safeParse(bank).success).toBe(true)
  })

  it('rejects when neither method is given', () => {
    expect(paymentDetailsSchema.safeParse({}).success).toBe(false)
    expect(paymentDetailsSchema.safeParse({ bankName: 'Maybank' }).success).toBe(false)
  })

  it('requires a 4-34 character account number', () => {
    expect(paymentDetailsSchema.safeParse({ ...bank, accountNumber: '123' }).success).toBe(false)
    expect(paymentDetailsSchema.safeParse({ ...bank, accountNumber: '1'.repeat(34) }).success).toBe(true)
    expect(paymentDetailsSchema.safeParse({ ...bank, accountNumber: '1'.repeat(35) }).success).toBe(false)
  })

  it('rejects a QR over 5 MB or of the wrong type', () => {
    const big = new File([new Uint8Array(MAX_QR_BYTES + 1)], 'qr.png', { type: 'image/png' })
    const gif = new File([new Uint8Array(10)], 'qr.gif', { type: 'image/gif' })
    expect(paymentDetailsSchema.safeParse({ qrFile: big }).success).toBe(false)
    expect(paymentDetailsSchema.safeParse({ qrFile: gif }).success).toBe(false)
  })

  it('prefers the only available method unless both are given', () => {
    expect(paymentDetailsSchema.parse({ qrFile: png() }).preferredMethod).toBe('qr')
    expect(paymentDetailsSchema.parse(bank).preferredMethod).toBe('bank')
    expect(paymentDetailsSchema.parse({ ...bank, qrFile: png(), preferredMethod: 'bank' }).preferredMethod).toBe('bank')
  })
})
