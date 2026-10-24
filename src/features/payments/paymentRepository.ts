import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase'
import { SettlementError, toSettlementErrorCode } from '../settlement/settlementRepository'

// Receivers write their own payment_details row and QR object directly (RLS +
// column grants from 202610240002/0003/0008). Payers, receivers and managers read a
// transfer's receiver details through get_receiver_details; the QR is shown via a
// short-lived signed URL that is kept in memory only, never stored.

const QR_BUCKET = 'payment-qr'
const SIGNED_URL_SECONDS = 600 // 10 minutes

export type PaymentDetailsInput = {
  preferredMethod: 'qr' | 'bank'
  bankName?: string | null
  accountHolderName?: string | null
  accountNumber?: string | null
  paymentReference?: string | null
}

export type ReceiverDetails = {
  receiverUserId: string
  preferredMethod: 'qr' | 'bank'
  bankName: string | null
  accountHolderName: string | null
  accountNumber: string | null
  paymentReference: string | null
  qrUrl: string | null // signed, expires after SIGNED_URL_SECONDS
}

type ReceiverDetailsRow = {
  receiver_user_id: string
  preferred_method: 'qr' | 'bank'
  bank_name: string | null
  account_holder_name: string | null
  account_number: string | null
  payment_reference: string | null
  qr_storage_path: string | null
}

async function call(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await client.rpc(fn, args)
  if (error) throw new SettlementError(toSettlementErrorCode(error), error)
  return data
}

// Best-effort delete; a failure is logged without details (the path and messages can hold user ids).
async function removeQr(client: SupabaseClient, path: string): Promise<void> {
  const { error } = await client.storage.from(QR_BUCKET).remove([path])
  if (error) console.warn('payment QR cleanup failed')
}

export function createPaymentRepository(client: SupabaseClient = supabase) {
  return {
    async saveMyPaymentDetails(eventId: string, details: PaymentDetailsInput, qrFile?: File): Promise<void> {
      const { data: session } = await client.auth.getSession()
      const me = session.session?.user.id
      if (!me) throw new SettlementError('not_authenticated')

      const existing = await client
        .from('payment_details')
        .select('qr_storage_path')
        .eq('event_id', eventId)
        .eq('receiver_user_id', me)
        .maybeSingle()
      if (existing.error) throw new SettlementError('action_failed', existing.error)
      const oldPath = (existing.data as { qr_storage_path: string | null } | null)?.qr_storage_path ?? null

      let newPath: string | null = null
      if (qrFile) {
        newPath = `${eventId}/${me}/${crypto.randomUUID()}`
        const { error } = await client.storage
          .from(QR_BUCKET)
          .upload(newPath, qrFile, { contentType: qrFile.type, upsert: false })
        if (error) throw new SettlementError('action_failed', error)
      }

      const row = {
        preferred_method: details.preferredMethod,
        bank_name: details.bankName ?? null,
        account_holder_name: details.accountHolderName ?? null,
        account_number: details.accountNumber ?? null,
        payment_reference: details.paymentReference ?? null,
        qr_storage_path: newPath ?? oldPath,
      }
      // Insert or update rather than upsert: clients may not UPDATE the key columns,
      // which a PostgREST upsert would set.
      const update = () => client.from('payment_details').update(row).eq('event_id', eventId).eq('receiver_user_id', me)
      let { error } = existing.data
        ? await update()
        : await client.from('payment_details').insert({ event_id: eventId, receiver_user_id: me, ...row })
      // A concurrent save inserted the row first: retry once as an update.
      if (error && !existing.data && (error as { code?: string }).code === '23505') ({ error } = await update())
      if (error) {
        if (newPath) await removeQr(client, newPath)
        throw new SettlementError(toSettlementErrorCode(error), error)
      }
      // Best effort: an orphaned old QR is only reachable by the same people.
      if (newPath && oldPath) await removeQr(client, oldPath)
    },

    // null when the receiver has not entered payment details yet.
    async getReceiverDetails(transferId: string): Promise<ReceiverDetails | null> {
      const rows = (await call(client, 'get_receiver_details', { transfer_id: transferId })) as ReceiverDetailsRow[] | null
      const row = rows?.[0]
      if (!row) return null
      let qrUrl: string | null = null
      if (row.qr_storage_path) {
        const { data, error } = await client.storage.from(QR_BUCKET).createSignedUrl(row.qr_storage_path, SIGNED_URL_SECONDS)
        if (error || !data) throw new SettlementError('action_failed', error)
        qrUrl = data.signedUrl
      }
      return {
        receiverUserId: row.receiver_user_id,
        preferredMethod: row.preferred_method,
        bankName: row.bank_name,
        accountHolderName: row.account_holder_name,
        accountNumber: row.account_number,
        paymentReference: row.payment_reference,
        qrUrl,
      }
    },

    markSent: async (transferId: string) => {
      await call(client, 'mark_payment_sent', { transfer_id: transferId })
    },
    confirmReceived: async (transferId: string) => {
      await call(client, 'confirm_payment_received', { transfer_id: transferId })
    },
    // Owner/co-host only; the server accepts only 'confirmed' as the target.
    override: async (transferId: string, reason: string) => {
      await call(client, 'override_payment_state', { transfer_id: transferId, target_state: 'confirmed', reason })
    },
  }
}
