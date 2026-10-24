import Dexie, { type EntityTable } from 'dexie'

// Reusable receiving details, remembered on this device only. A SEPARATE database from the
// drafts DB (`friends-bill-splitter`); one row per anonymous user id. Never logged or sent anywhere.

export type RememberedPayment = {
  userId: string
  preferredMethod: 'qr' | 'bank'
  bankName: string | null
  accountHolderName: string | null
  accountNumber: string | null
  paymentReference: string | null
  qr: Blob | null
}

class PrefsDb extends Dexie {
  payment!: EntityTable<RememberedPayment, 'userId'>
  constructor() {
    super('friends-bill-splitter-prefs')
    this.version(1).stores({ payment: 'userId' })
  }
}

let db: PrefsDb | null = null
const open = () => (db ??= new PrefsDb())

export const paymentPrefs = {
  load: async (userId: string): Promise<RememberedPayment | null> => (await open().payment.get(userId)) ?? null,
  save: async (value: RememberedPayment): Promise<void> => {
    await open().payment.put(value)
  },
  forget: async (userId: string): Promise<void> => {
    await open().payment.delete(userId)
  },
}
