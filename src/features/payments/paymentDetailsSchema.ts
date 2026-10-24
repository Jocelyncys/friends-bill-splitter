import { z } from 'zod'

export const MAX_QR_BYTES = 5 * 1024 * 1024
export const QR_TYPES = ['image/png', 'image/jpeg', 'image/webp']

const qrFile = z
  .instanceof(Blob)
  .refine(file => QR_TYPES.includes(file.type), { message: 'qr_type' })
  .refine(file => file.size <= MAX_QR_BYTES, { message: 'qr_size' })

const text = z.string().trim().optional()

export const paymentDetailsSchema = z
  .object({
    qrFile: qrFile.nullish(),
    bankName: text,
    accountHolderName: text,
    accountNumber: z
      .string()
      .trim()
      .optional()
      .refine(v => !v || (v.length >= 4 && v.length <= 34), { message: 'account_number' }),
    paymentReference: z.string().trim().max(100).optional(),
    preferredMethod: z.enum(['qr', 'bank']).optional(),
  })
  .refine(v => Boolean(v.qrFile) || Boolean(v.bankName && v.accountHolderName && v.accountNumber), {
    message: 'method_required',
    path: ['qrFile'],
  })
  .transform(v => {
    const hasBank = Boolean(v.bankName && v.accountHolderName && v.accountNumber)
    const hasQr = Boolean(v.qrFile)
    const preferredMethod: 'qr' | 'bank' = hasQr && hasBank ? (v.preferredMethod ?? 'qr') : hasQr ? 'qr' : 'bank'
    return {
      preferredMethod,
      qrFile: v.qrFile ?? null,
      // Bank fields are only kept when they form a complete set.
      bankName: hasBank ? v.bankName! : null,
      accountHolderName: hasBank ? v.accountHolderName! : null,
      accountNumber: hasBank ? v.accountNumber! : null,
      paymentReference: v.paymentReference || null,
    }
  })

export type PaymentDetailsValues = z.output<typeof paymentDetailsSchema>
