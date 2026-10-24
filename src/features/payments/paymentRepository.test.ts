import { describe, expect, it, vi } from 'vitest'
import { SettlementError } from '../settlement/settlementRepository'
import { createPaymentRepository } from './paymentRepository'

type Result = { data: unknown; error: unknown }

function fakeClient(options: { existing?: { qr_storage_path: string | null } | null; writeError?: unknown } = {}) {
  const writes: Array<{ op: string; row: unknown; filters: unknown[] }> = []
  const from = vi.fn(() => {
    let op = 'select'
    let row: unknown = null
    const filters: unknown[] = []
    const b = {
      select: () => b,
      insert: (r: unknown) => { op = 'insert'; row = r; return b },
      update: (r: unknown) => { op = 'update'; row = r; return b },
      eq: (...args: unknown[]) => { filters.push(args); return b },
      maybeSingle: () => b,
      then: (resolve: (r: Result) => unknown) => {
        if (op === 'select') return Promise.resolve({ data: options.existing ?? null, error: null }).then(resolve)
        writes.push({ op, row, filters })
        return Promise.resolve({ data: null, error: options.writeError ?? null }).then(resolve)
      },
    }
    return b
  })
  const upload = vi.fn().mockResolvedValue({ data: {}, error: null })
  const remove = vi.fn().mockResolvedValue({ data: [], error: null })
  const createSignedUrl = vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed/qr?token=x' }, error: null })
  const storageFrom = vi.fn(() => ({ upload, remove, createSignedUrl }))
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null })
  const getSession = vi.fn().mockResolvedValue({ data: { session: { user: { id: 'me' } } }, error: null })
  const client = { from, rpc, storage: { from: storageFrom }, auth: { getSession } }
  return { client: client as never, writes, upload, remove, createSignedUrl, storageFrom, rpc, from }
}

const bank = { preferredMethod: 'bank' as const, bankName: 'Maybank', accountHolderName: 'Me', accountNumber: '123', paymentReference: 'trip' }

describe('paymentRepository.saveMyPaymentDetails', () => {
  it('inserts a new row for the caller without a QR', async () => {
    const f = fakeClient()
    await createPaymentRepository(f.client).saveMyPaymentDetails('event-1', bank)
    expect(f.upload).not.toHaveBeenCalled()
    expect(f.writes).toEqual([{
      op: 'insert',
      row: { event_id: 'event-1', receiver_user_id: 'me', preferred_method: 'bank', bank_name: 'Maybank',
        account_holder_name: 'Me', account_number: '123', payment_reference: 'trip', qr_storage_path: null },
      filters: [],
    }])
  })

  it('uploads the QR under <event>/<me>/<uuid>, stores only the path and deletes the replaced QR', async () => {
    const f = fakeClient({ existing: { qr_storage_path: 'event-1/me/old' } })
    const file = new File(['png'], 'qr.png', { type: 'image/png' })
    await createPaymentRepository(f.client).saveMyPaymentDetails('event-1', { preferredMethod: 'qr' }, file)
    expect(f.storageFrom).toHaveBeenCalledWith('payment-qr')
    const [path, body, uploadOptions] = f.upload.mock.calls[0]
    expect(path).toMatch(/^event-1\/me\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(body).toBe(file)
    expect(uploadOptions).toEqual({ contentType: 'image/png', upsert: false })
    expect(f.writes).toEqual([{
      op: 'update',
      row: { preferred_method: 'qr', bank_name: null, account_holder_name: null, account_number: null,
        payment_reference: null, qr_storage_path: path },
      filters: [['event_id', 'event-1'], ['receiver_user_id', 'me']],
    }])
    expect(f.remove).toHaveBeenCalledWith(['event-1/me/old'])
  })

  it('keeps the existing QR path when no new file is given', async () => {
    const f = fakeClient({ existing: { qr_storage_path: 'event-1/me/old' } })
    await createPaymentRepository(f.client).saveMyPaymentDetails('event-1', bank)
    expect(f.writes[0].row).toMatchObject({ qr_storage_path: 'event-1/me/old' })
    expect(f.remove).not.toHaveBeenCalled()
  })

  it('removes the new upload when the row write fails', async () => {
    const f = fakeClient({ writeError: { code: '23514', message: 'check' } })
    const file = new File(['png'], 'qr.png', { type: 'image/png' })
    const error = await createPaymentRepository(f.client).saveMyPaymentDetails('event-1', { preferredMethod: 'qr' }, file)
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SettlementError)
    expect((error as SettlementError).code).toBe('invalid_payment_details')
    expect(f.remove).toHaveBeenCalledWith([f.upload.mock.calls[0][0]])
  })
})

describe('paymentRepository.getReceiverDetails', () => {
  it('calls the RPC and returns a 600-second signed URL held only in memory', async () => {
    const f = fakeClient()
    f.rpc.mockResolvedValueOnce({
      data: [{ receiver_user_id: 'ali', preferred_method: 'qr', bank_name: null, account_holder_name: 'Ali',
        account_number: null, payment_reference: null, qr_storage_path: 'event-1/ali/q' }],
      error: null,
    })
    const details = await createPaymentRepository(f.client).getReceiverDetails('t1')
    expect(f.rpc).toHaveBeenCalledWith('get_receiver_details', { transfer_id: 't1' })
    expect(f.createSignedUrl).toHaveBeenCalledWith('event-1/ali/q', 600)
    expect(details).toEqual({
      receiverUserId: 'ali', preferredMethod: 'qr', bankName: null, accountHolderName: 'Ali', accountNumber: null,
      paymentReference: null, qrUrl: 'https://signed/qr?token=x',
    })
    // Never persisted: no table write or upload, and the path itself is not handed to the UI.
    expect(f.from).not.toHaveBeenCalled()
    expect(f.upload).not.toHaveBeenCalled()
    expect(JSON.stringify(details)).not.toContain('event-1/ali/q')
  })

  it('returns null when the receiver has not entered details and skips signing without a QR', async () => {
    const f = fakeClient()
    f.rpc.mockResolvedValueOnce({ data: [], error: null })
    await expect(createPaymentRepository(f.client).getReceiverDetails('t1')).resolves.toBeNull()
    f.rpc.mockResolvedValueOnce({ data: [{ receiver_user_id: 'ali', preferred_method: 'bank', bank_name: 'B',
      account_holder_name: 'Ali', account_number: '1', payment_reference: null, qr_storage_path: null }], error: null })
    await expect(createPaymentRepository(f.client).getReceiverDetails('t1')).resolves.toMatchObject({ qrUrl: null })
    expect(f.createSignedUrl).not.toHaveBeenCalled()
  })

  it('maps transfer_not_found', async () => {
    const f = fakeClient()
    f.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'transfer_not_found' } })
    await expect(createPaymentRepository(f.client).getReceiverDetails('t1')).rejects.toMatchObject({ code: 'transfer_not_found' })
  })
})

describe('paymentRepository transitions', () => {
  it('calls each transition RPC with its snake_case arguments', async () => {
    const f = fakeClient()
    const repository = createPaymentRepository(f.client)
    await repository.markSent('t1')
    await repository.confirmReceived('t1')
    await repository.override('t1', 'Paid in cash')
    expect(f.rpc.mock.calls).toEqual([
      ['mark_payment_sent', { transfer_id: 't1' }],
      ['confirm_payment_received', { transfer_id: 't1' }],
      ['override_payment_state', { transfer_id: 't1', target_state: 'confirmed', reason: 'Paid in cash' }],
    ])
  })

  it('maps invalid_transition to a typed error', async () => {
    const f = fakeClient()
    f.rpc.mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'invalid_transition' } })
    await expect(createPaymentRepository(f.client).markSent('t1')).rejects.toMatchObject({ code: 'invalid_transition' })
  })
})
