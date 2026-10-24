import { describe, expect, it } from 'vitest'
import { buildPayload, customDifference, parseMoneyToCents, validateDraft, type ExpenseDraft } from './expenseForm'

describe('parseMoneyToCents', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12.50', 1250],
    [' 0.01 ', 1],
    ['19.99', 1999],
    ['1.15', 115],
  ])('accepts %s', (text, expected) => expect(parseMoneyToCents(text)).toBe(expected))

  it.each(['12.505', '', 'abc', '0', '0.00', '-5', '-0.50', '1,5', '1e3', '.5', '12.'])('rejects %j', text =>
    expect(parseMoneyToCents(text)).toBeNull(),
  )
})

const base: ExpenseDraft = {
  description: 'Dinner',
  amount: '10.00',
  payerUserId: 'u-a',
  expenseDate: '2026-10-25',
  splitMethod: 'equal',
  participantIds: ['u-c', 'u-a', 'u-b'],
  shares: {},
  items: [],
}
const ctx = { id: 'exp-1', eventId: 'ev-1' }

function ok(draft: ExpenseDraft) {
  const result = validateDraft(draft)
  if (!result.ok) throw new Error(`invalid: ${JSON.stringify(result.errors)}`)
  return buildPayload(ctx, result.values)
}

describe('validateDraft + buildPayload', () => {
  it('equal split preserves every cent, extra cents to lowest sorted ids', () => {
    const payload = ok(base)
    expect(payload.totalCents).toBe(1000)
    expect(payload.splitMethod).toBe('equal')
    expect(payload.items).toEqual([])
    expect(payload.allocations).toEqual([
      { itemId: null, participantUserId: 'u-a', amountCents: 334 },
      { itemId: null, participantUserId: 'u-b', amountCents: 333 },
      { itemId: null, participantUserId: 'u-c', amountCents: 333 },
    ])
    expect(payload).toMatchObject({ id: 'exp-1', eventId: 'ev-1', payerUserId: 'u-a', description: 'Dinner', expenseDate: '2026-10-25' })
  })

  it('rejects equal with no participants', () => {
    expect(validateDraft({ ...base, participantIds: [] }).ok).toBe(false)
  })

  it('custom shares must add up to the total', () => {
    const custom: ExpenseDraft = { ...base, splitMethod: 'custom', shares: { 'u-a': '4', 'u-b': '5.50' } }
    expect(validateDraft(custom)).toMatchObject({ ok: false, errors: { shares: 'shares_mismatch' } })
    expect(customDifference(custom.amount, custom.shares)).toBe(50)
    const good = ok({ ...custom, shares: { 'u-a': '4', 'u-b': '6', 'u-c': '' } })
    expect(good.allocations).toEqual([
      { itemId: null, participantUserId: 'u-a', amountCents: 400 },
      { itemId: null, participantUserId: 'u-b', amountCents: 600 },
    ])
  })

  it('items total is the sum of rows and maps to item_claim with no allocations', () => {
    const payload = ok({
      ...base,
      splitMethod: 'items',
      amount: '',
      items: [
        { id: 'i1', description: 'Noodles', price: '8.10', assigneeId: '' },
        { id: 'i2', description: 'Tea', price: '2.35', assigneeId: '' },
      ],
    })
    expect(payload.splitMethod).toBe('item_claim')
    expect(payload.totalCents).toBe(1045)
    expect(payload.items).toEqual([
      { id: 'i1', description: 'Noodles', quantity: 1, totalCents: 810, sortOrder: 0 },
      { id: 'i2', description: 'Tea', quantity: 1, totalCents: 235, sortOrder: 1 },
    ])
    expect(payload.allocations).toEqual([])
  })

  it('host_assignment allocates each item fully to its assignee', () => {
    const payload = ok({
      ...base,
      splitMethod: 'host_assignment',
      amount: '',
      items: [
        { id: 'i1', description: 'Noodles', price: '8.10', assigneeId: 'u-b' },
        { id: 'i2', description: 'Tea', price: '2.35', assigneeId: 'u-c' },
      ],
    })
    expect(payload.splitMethod).toBe('host_assignment')
    expect(payload.totalCents).toBe(1045)
    expect(payload.allocations).toEqual([
      { itemId: 'i1', participantUserId: 'u-b', amountCents: 810 },
      { itemId: 'i2', participantUserId: 'u-c', amountCents: 235 },
    ])
  })

  it('host_assignment requires an assignee per item', () => {
    const r = validateDraft({ ...base, splitMethod: 'host_assignment', items: [{ id: 'i1', description: 'A', price: '1', assigneeId: '' }] })
    expect(r).toMatchObject({ ok: false, errors: { items: 'items_invalid' } })
  })

  it('rejects more than two decimals and sub-cent totals', () => {
    expect(validateDraft({ ...base, amount: '10.005' })).toMatchObject({ ok: false, errors: { amount: 'amount_invalid' } })
    expect(validateDraft({ ...base, amount: '0.00' })).toMatchObject({ ok: false, errors: { amount: 'amount_invalid' } })
    expect(validateDraft({ ...base, splitMethod: 'items', items: [{ id: 'i', description: 'x', price: '1.001', assigneeId: '' }] })).toMatchObject({ ok: false })
  })

  it('requires a description', () => {
    expect(validateDraft({ ...base, description: '  ' })).toMatchObject({ ok: false, errors: { description: 'description_required' } })
  })
})
