import { describe, expect, it } from 'vitest'
import {
  buildPayload,
  customDifference,
  draftFromPayload,
  itemCentsByPerson,
  parseMoneyToCents,
  validateDraft,
  type ExpenseDraft,
} from './expenseForm'
import type { SaveExpensePayload } from './expenseRepository'

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
        { id: 'i1', description: 'Noodles', price: '8.10', assigneeIds: [] },
        { id: 'i2', description: 'Tea', price: '2.35', assigneeIds: [] },
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
        { id: 'i1', description: 'Noodles', price: '8.10', assigneeIds: ['u-b'] },
        { id: 'i2', description: 'Tea', price: '2.35', assigneeIds: ['u-c'] },
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
    const r = validateDraft({ ...base, splitMethod: 'host_assignment', items: [{ id: 'i1', description: 'A', price: '1', assigneeIds: [] }] })
    expect(r).toMatchObject({ ok: false, errors: { items: 'items_invalid' } })
  })

  it('rejects more than two decimals and sub-cent totals', () => {
    expect(validateDraft({ ...base, amount: '10.005' })).toMatchObject({ ok: false, errors: { amount: 'amount_invalid' } })
    expect(validateDraft({ ...base, amount: '0.00' })).toMatchObject({ ok: false, errors: { amount: 'amount_invalid' } })
    expect(validateDraft({ ...base, splitMethod: 'items', items: [{ id: 'i', description: 'x', price: '1.001', assigneeIds: [] }] })).toMatchObject({ ok: false })
  })

  it('requires a description', () => {
    expect(validateDraft({ ...base, description: '  ' })).toMatchObject({ ok: false, errors: { description: 'description_required' } })
  })
})

describe('draftFromPayload', () => {
  const head = { description: 'Dinner', payerUserId: 'u-a', expenseDate: '2026-10-25', amount: '', participantIds: ['u-a', 'u-b'], shares: {} }
  const roundTrip = (draft: ExpenseDraft) => {
    const first = validateDraft(draft)
    if (!first.ok) throw new Error('fixture invalid')
    const payload = buildPayload({ id: 'e1', eventId: 'ev' }, first.values)
    const again = validateDraft(draftFromPayload(payload))
    if (!again.ok) throw new Error('refilled form invalid')
    expect(buildPayload({ id: 'e1', eventId: 'ev' }, again.values)).toEqual(payload)
  }
  const items = [
    { id: 'i1', description: 'Noodles', price: '8.10', assigneeIds: ['u-b'] },
    { id: 'i2', description: 'Tea', price: '2.35', assigneeIds: ['u-a'] },
  ]

  it('refills every split method so saving again yields the identical payload', () => {
    roundTrip({ ...head, splitMethod: 'equal', amount: '10.01', items: [] })
    roundTrip({ ...head, splitMethod: 'custom', amount: '10.00', shares: { 'u-a': '4.00', 'u-b': '6.00' }, items: [] })
    roundTrip({ ...head, splitMethod: 'items', items })
    roundTrip({ ...head, splitMethod: 'host_assignment', items })
  })

  const legacy = (splitMethod: 'item_claim' | 'host_assignment', adjustments?: SaveExpensePayload['adjustments'], totalCents = 2500): SaveExpensePayload => ({
    id: 'e1', eventId: 'ev', payerUserId: 'u-a', description: 'Dinner', expenseDate: '2026-10-25',
    totalCents, splitMethod,
    items: [
      { id: 'i1', description: 'Noodles', quantity: 1, totalCents: 1111, sortOrder: 0 },
      { id: 'i2', description: 'Tea', quantity: 1, totalCents: 1746, sortOrder: 1 },
    ],
    allocations: [
      { itemId: 'i1', participantUserId: 'u-a', amountCents: 1111 },
      { itemId: 'i2', participantUserId: 'u-b', amountCents: 1746 },
    ],
    ...(adjustments ? { adjustments } : {}),
  })

  it('shows the amount paid of a saved expense with several adjustment rows and collapses them into one on save', () => {
    const adjustments = [
      { id: 'a1', kind: 'discount' as const, label: 'Voucher', amountCents: -500, sortOrder: 0 },
      { id: 'a2', kind: 'tax' as const, label: 'SST', amountCents: 141, sortOrder: 1 },
      { id: 'a3', kind: 'rounding' as const, label: 'Rounding', amountCents: 2, sortOrder: 2 },
    ]
    for (const splitMethod of ['item_claim', 'host_assignment'] as const) {
      const saved = legacy(splitMethod, adjustments)
      const draft = draftFromPayload(saved)
      expect(draft.amount).toBe('25.00')
      const again = validateDraft(draft)
      if (!again.ok) throw new Error('refilled form invalid')
      expect(buildPayload({ id: 'e1', eventId: 'ev' }, again.values)).toEqual({
        ...saved,
        adjustments: [{ id: 'e1', kind: 'other', label: null, amountCents: -357, sortOrder: 0 }],
      })
    }
  })

  it('round-trips an amount paid exactly (offline drafts and edits)', () => {
    for (const amount of ['25.00', '30.01', '0.01']) {
      const draft: ExpenseDraft = { ...head, splitMethod: 'host_assignment', amount, items }
      roundTrip(draft)
      const r = validateDraft(draft)
      if (!r.ok) throw new Error('fixture invalid')
      expect(draftFromPayload(buildPayload({ id: 'e1', eventId: 'ev' }, r.values)).amount).toBe(amount)
    }
  })

  it('leaves Amount paid empty for a saved itemized payload without adjustments', () => {
    expect(draftFromPayload(legacy('host_assignment', undefined, 2857)).amount).toBe('')
    expect(draftFromPayload(legacy('item_claim', [], 2857)).amount).toBe('')
  })
})

describe('final-review fixes', () => {
  const okPayload = (draft: ExpenseDraft, extra: { category?: string } = {}) => {
    const r = validateDraft(draft)
    if (!r.ok) throw new Error(JSON.stringify(r.errors))
    return buildPayload({ ...ctx, ...extra }, r.values)
  }

  it.each(['0', '0.00', '0.0'])('custom share %j counts as excluded, not a mismatch', zero => {
    const payload = okPayload({ ...base, splitMethod: 'custom', shares: { 'u-a': '10', 'u-b': zero } })
    expect(payload.allocations).toEqual([{ itemId: null, participantUserId: 'u-a', amountCents: 1000 }])
    expect(customDifference('10', { 'u-a': '10', 'u-b': zero })).toBe(0)
  })

  it('still needs a total of at least 1 cent when every share is zero', () => {
    expect(validateDraft({ ...base, splitMethod: 'custom', amount: '0', shares: { 'u-a': '0' } })).toMatchObject({
      ok: false,
      errors: { amount: 'amount_invalid' },
    })
    expect(validateDraft({ ...base, splitMethod: 'custom', shares: { 'u-a': '0', 'u-b': '0.00' } })).toMatchObject({
      ok: false,
      errors: { shares: 'shares_mismatch' },
    })
  })

  it('itemized (claim) mode keeps an existing whole-item assignment and leaves other items unallocated', () => {
    const payload = okPayload({
      ...base,
      splitMethod: 'items',
      amount: '',
      items: [
        { id: 'i1', description: 'Noodles', price: '8.10', assigneeIds: ['u-b'] },
        { id: 'i2', description: 'Tea', price: '2.35', assigneeIds: [] },
      ],
    })
    expect(payload.splitMethod).toBe('item_claim')
    expect(payload.allocations).toEqual([{ itemId: 'i1', participantUserId: 'u-b', amountCents: 810 }])
  })

  it('keeps the saved category when one is given', () => {
    expect(okPayload(base, { category: 'food' }).category).toBe('food')
    expect(okPayload(base).category).toBeUndefined()
  })
})

describe('multi-person assignment', () => {
  const itemized = (items: ExpenseDraft['items'], splitMethod: ExpenseDraft['splitMethod'] = 'host_assignment'): ExpenseDraft => ({
    ...base,
    splitMethod,
    amount: '',
    items,
  })

  it('host_assignment splits a shared item equally, extra cents by id order', () => {
    const payload = ok(itemized([
      { id: 'i1', description: 'Platter', price: '10.01', assigneeIds: ['u-c', 'u-a', 'u-b'] },
      { id: 'i2', description: 'Tea', price: '2.00', assigneeIds: ['u-b'] },
    ]))
    expect(payload.totalCents).toBe(1201)
    expect(payload.allocations).toEqual([
      { itemId: 'i1', participantUserId: 'u-a', amountCents: 334 },
      { itemId: 'i1', participantUserId: 'u-b', amountCents: 334 },
      { itemId: 'i1', participantUserId: 'u-c', amountCents: 333 },
      { itemId: 'i2', participantUserId: 'u-b', amountCents: 200 },
    ])
  })

  it('itemized (claim) keeps a multi-person assignment from the saved expense', () => {
    const payload = ok(itemized([{ id: 'i1', description: 'Platter', price: '8.00', assigneeIds: ['u-b', 'u-a'] }], 'items'))
    expect(payload.allocations).toEqual([
      { itemId: 'i1', participantUserId: 'u-a', amountCents: 400 },
      { itemId: 'i1', participantUserId: 'u-b', amountCents: 400 },
    ])
  })

  it('draftFromPayload carries every assignee of an item and round-trips', () => {
    const saved = ok(itemized([
      { id: 'i1', description: 'Platter', price: '10.01', assigneeIds: ['u-a', 'u-b', 'u-c'] },
      { id: 'i2', description: 'Tea', price: '2.00', assigneeIds: ['u-b'] },
    ]))
    const draft = draftFromPayload(saved)
    expect(draft.items.map(i => i.assigneeIds)).toEqual([['u-a', 'u-b', 'u-c'], ['u-b']])
    const again = validateDraft(draft)
    if (!again.ok) throw new Error('refilled form invalid')
    expect(buildPayload(ctx, again.values)).toEqual(saved)
  })

  it('itemCentsByPerson sums each person item shares, or null while anything is unassigned or unpriced', () => {
    expect(itemCentsByPerson([
      { id: 'i1', description: 'Platter', price: '10.01', assigneeIds: ['u-c', 'u-a', 'u-b'] },
      { id: 'i2', description: 'Tea', price: '2.00', assigneeIds: ['u-b'] },
    ])).toEqual({ 'u-a': 334, 'u-b': 534, 'u-c': 333 })
    expect(itemCentsByPerson([{ id: 'i1', description: 'Tea', price: '2.00', assigneeIds: [] }])).toBeNull()
    expect(itemCentsByPerson([{ id: 'i1', description: 'Tea', price: 'x', assigneeIds: ['u-a'] }])).toBeNull()
  })
})

describe('amount paid', () => {
  const receipt = (amount: string, splitMethod: ExpenseDraft['splitMethod'] = 'host_assignment'): ExpenseDraft => ({
    ...base,
    splitMethod,
    amount,
    items: [
      { id: 'i1', description: 'Rice', price: '11.11', assigneeIds: ['u-a'] },
      { id: 'i2', description: 'Pork', price: '17.46', assigneeIds: ['u-b'] },
    ],
  })

  it('sends one unlabelled other adjustment for the difference and the amount paid as the total', () => {
    for (const method of ['items', 'host_assignment'] as const) {
      const payload = ok(receipt('25.00', method))
      expect(payload.totalCents).toBe(2500)
      expect(payload.adjustments).toEqual([{ id: ctx.id, kind: 'other', label: null, amountCents: -357, sortOrder: 0 }])
    }
  })

  it('adds a positive difference when more was paid than the items (service charge)', () => {
    const payload = ok(receipt('30.00'))
    expect(payload.totalCents).toBe(3000)
    expect(payload.adjustments).toEqual([{ id: ctx.id, kind: 'other', label: null, amountCents: 143, sortOrder: 0 }])
  })

  it.each(['', '  ', '28.57'])('sends no adjustment when Amount paid is %j (empty or equal to the items)', amount => {
    const payload = ok(receipt(amount))
    expect(payload.totalCents).toBe(2857)
    expect(payload.adjustments).toEqual([])
  })

  it.each(['0', '0.00', '-1', '1.005', 'abc'])('rejects Amount paid %j', amount => {
    expect(validateDraft(receipt(amount))).toMatchObject({ ok: false, errors: { amount: 'amount_invalid' } })
  })

  it('equal and custom splits never send adjustments', () => {
    const payload = ok({ ...base })
    expect(payload.adjustments).toBeUndefined()
    expect(payload.totalCents).toBe(1000)
  })
})
