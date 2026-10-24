export type MoneyCents = number & { readonly __moneyCents: unique symbol }
export type AllocationMap = Record<string, number>

export type EventMode = 'single_bill' | 'trip_event'
export type EventRole = 'owner' | 'cohost' | 'participant'
export type SplitMethod = 'item_claim' | 'host_assignment' | 'equal' | 'custom'
export type EventState = 'open' | 'settlement_preview' | 'settled'
