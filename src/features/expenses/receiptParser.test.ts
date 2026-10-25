import { describe, expect, it } from 'vitest'
import { parseReceipt, parseReceiptLines } from './receiptParser'

describe('parseReceiptLines', () => {
  it('extracts likely item names and rightmost prices', () => {
    expect(parseReceiptLines(['NASI LEMAK 12.50', 'TEH O 3.00', 'TOTAL 15.50'])).toEqual([
      { description: 'NASI LEMAK', totalCents: 1250 },
      { description: 'TEH O', totalCents: 300 },
    ])
  })

  it('accepts comma decimals, an RM prefix and thousands separators', () => {
    expect(parseReceiptLines(['ROTI 12,50', 'SET MEAL RM 8.90', 'WINE 1,234.50'])).toEqual([
      { description: 'ROTI', totalCents: 1250 },
      { description: 'SET MEAL', totalCents: 890 },
      { description: 'WINE', totalCents: 123450 },
    ])
  })

  it('ignores lines without a price, zero prices and blank lines', () => {
    expect(parseReceiptLines(['THANK YOU', '', 'FREE REFILL 0.00', 'TEH 3.00'])).toEqual([{ description: 'TEH', totalCents: 300 }])
  })

  it('excludes summary lines case-insensitively', () => {
    expect(
      parseReceiptLines(['Subtotal 10.00', 'SERVICE CHARGE 1.00', 'Gst 0.60', 'sst 0.60', 'Tax 1.00', 'Cash 20.00', 'CHANGE 5.00', 'Total 11.60']),
    ).toEqual([])
  })

  describe('Malaysian POS receipts', () => {
    it('strips a leading quantity and a dangling unit-price fragment', () => {
      expect(parseReceiptLines(['1 Fragrant Rice香米白饭（2.20/ 2.20'])).toEqual([{ description: 'Fragrant Rice香米白饭', totalCents: 220 }])
    })

    it('strips a trailing "ea)" fragment', () => {
      expect(parseReceiptLines(['1 stir Fried Pork with Chili Pep ea) 18.90'])).toEqual([
        { description: 'stir Fried Pork with Chili Pep', totalCents: 1890 },
      ])
    })

    it('strips a "(ref: ...)" note', () => {
      expect(parseReceiptLines(['Century Egg w/Amaranth 皮蛋范 (ref: Member Discount) 16.00'])).toEqual([
        { description: 'Century Egg w/Amaranth 皮蛋范', totalCents: 1600 },
      ])
    })

    it('strips a complete "(x.xx/ea)" unit price', () => {
      expect(parseReceiptLines(['2 Iced Lemon Tea (3.50/ea) 7.00'])).toEqual([{ description: 'Iced Lemon Tea', totalCents: 700 }])
    })

    it('excludes the charges summary and bill-level lines, even with OCR noise at the start', () => {
      expect(
        parseReceiptLines([
          'harges summary 23.57 Base Amt. Amount',
          'harges summary 23.57',
          'Charges Summary 23.57',
          'Base Amt. 21.40',
          'Amount 23.57',
          'Qty 3.00',
          'SubTotal 23.40',
          'Voucher -5.00 5.00',
          'Rounding 0.03',
          '- SST 6% 1.28',
          'Service Charge 10% 2.14',
          '* Total 23.55',
          'Cash 50.00',
          'Change 26.45',
        ]),
      ).toEqual([])
    })
  })
})

describe('parseReceipt adjustments', () => {
  // The user's real receipt (items 2.20, 8.91, 5.31, 8.64, 3.51 after member discounts), grouped into lines the
  // way ocrLines rebuilds them: description, unit-price fragment, then the right-aligned amount(s).
  const realReceipt = [
    'TAX INVOICE',
    'SST ID: W10-1808-32000123',
    '1 Fragrant Rice香米白饭（2.20/ 2.20',
    '1 stir Fried Pork with Chili Pep ea) 8.91',
    'Membership Discount: -10% -0.99',
    'Century Egg w/Amaranth 皮蛋范 (ref: Member Discount) 5.31',
    'Membership Discount: -10%',
    '2 Iced Lemon Tea (4.32/ea) 8.64',
    'Member Discount 0.96',
    '1 Kailan Garlic 3.51',
    'Subtotal 28.57',
    'Voucher Discount: -5.0 -5.00',
    'SST (6%) 1.41',
    'Bill rounding 0.02',
    'Total (MYR) 25.00',
    'harges summary 23.57 Base Amt. Amount',
    'Cash 50.00',
    'Change 25.00',
  ]

  it('reads the items and the voucher, SST and rounding lines of the real receipt', () => {
    const { items, adjustments } = parseReceipt(realReceipt)
    expect(items.map(i => i.totalCents)).toEqual([220, 891, 531, 864, 351])
    expect(adjustments).toEqual([
      { kind: 'discount', label: 'Voucher Discount', amountCents: -500 },
      { kind: 'tax', label: 'SST (6%)', amountCents: 141 },
      { kind: 'rounding', label: 'Bill rounding', amountCents: 2 },
    ])
    const paid = [...items, ...adjustments.map(a => ({ totalCents: a.amountCents }))].reduce((s, x) => s + x.totalCents, 0)
    expect(paid).toBe(2500)
  })

  it('parseReceiptLines still returns only the items', () => {
    expect(parseReceiptLines(realReceipt).map(i => i.totalCents)).toEqual([220, 891, 531, 864, 351])
  })

  it.each([
    ['Discount 3.00', { kind: 'discount', label: 'Discount', amountCents: -300 }],
    ['DISC -2.50', { kind: 'discount', label: 'DISC', amountCents: -250 }],
    ['voucher: RM 10.00', { kind: 'discount', label: 'voucher', amountCents: -1000 }],
    ['- SST 6% 1.28', { kind: 'tax', label: 'SST 6%', amountCents: 128 }],
    ['GST 0.60', { kind: 'tax', label: 'GST', amountCents: 60 }],
    ['Tax 1,00', { kind: 'tax', label: 'Tax', amountCents: 100 }],
    ['Service Charge 10% 2.14', { kind: 'service', label: 'Service Charge 10%', amountCents: 214 }],
    ['SVC CHG 1.50', { kind: 'service', label: 'SVC CHG', amountCents: 150 }],
    ['Rounding -0.02', { kind: 'rounding', label: 'Rounding', amountCents: -2 }],
    ['* Rounding Adj 0.03', { kind: 'rounding', label: 'Rounding Adj', amountCents: 3 }],
  ])('reads %j', (line, expected) => {
    expect(parseReceipt([line])).toEqual({ items: [], adjustments: [expected] })
  })

  it('skips zero adjustments, per-item member discounts and summary lines', () => {
    expect(
      parseReceipt([
        'Rounding 0.00',
        'Membership Discount: -10% -0.99',
        'Member Discount 0.96',
        'Total Discount 5.00',
        'Subtotal 28.57',
        'Total 25.00',
        'Grand Total 25.00',
        'Cash 50.00',
        'Change 25.00',
        'Base Amt. 21.40',
        'Qty 3.00',
      ]),
    ).toEqual({ items: [], adjustments: [] })
  })

  it('caps a long label at 60 characters', () => {
    const { adjustments } = parseReceipt([`Service charge ${'x'.repeat(80)} 1.00`])
    expect(adjustments[0].label).toHaveLength(60)
  })
})
