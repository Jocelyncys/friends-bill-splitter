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

describe('parseReceipt total', () => {
  // The user's real receipt as the in-app OCR engine read it: items (2.20, 8.91, 5.31, 8.64, 3.51 after member
  // discounts), then the summary lines exactly as recognised. Only the Total line is reliable.
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
    '5 Subtotal gty. 28.0',
    'youcher Discount: -5.0 (ref; Cheras RM5 off Voucher)',
    'SST(6%) Bil rounding 0.2',
    'Total (MYR) DUIT NOW 25.00 25.00',
    'Change 20.00',
    'harges summary 23.57 Base Amt. Amount 1.41',
  ]

  it('reads the items and the amount paid from the Total line of the real receipt', () => {
    const { items, totalCents } = parseReceipt(realReceipt)
    expect(items.map(i => i.totalCents)).toEqual([220, 891, 531, 864, 351])
    expect(items.reduce((sum, i) => sum + i.totalCents, 0)).toBe(2857)
    expect(totalCents).toBe(2500)
  })

  it('no longer produces adjustment rows', () => {
    expect(parseReceipt(realReceipt)).not.toHaveProperty('adjustments')
  })

  it.each([
    ['Grand Total 19.60', 1960],
    ['TOTAL 15.50', 1550],
    ['Total RM 1,234.50', 123450],
    ['* Total: 25,00', 2500],
  ])('reads %j as %i', (line, cents) => {
    expect(parseReceipt([line]).totalCents).toBe(cents)
  })

  it.each([
    ['Subtotal 28.57'],
    ['Sub Total 28.57'],
    ['Sub-total 28.57'],
    ['Total Discount 5.00'],
    ['Total Qty 3.00'],
    ['Total Items 5.00'],
    ['Total'],
    ['THANK YOU'],
  ])('has no total for %j alone', line => {
    expect(parseReceipt([line]).totalCents).toBeUndefined()
  })

  it('prefers a Total line with the currency, then the lowest one on the receipt', () => {
    expect(parseReceipt(['Total 30.00', 'Total (MYR) 25.00', 'Total 12.00']).totalCents).toBe(2500)
    expect(parseReceipt(['Total 30.00', 'Grand Total 28.00']).totalCents).toBe(2800)
  })

  it('never turns bill-level lines into items', () => {
    expect(
      parseReceipt(['Discount 3.00', 'DISC -2.50', 'voucher: RM 10.00', 'Service Charge 10% 2.14', 'SVC CHG 1.50', 'Rounding -0.02', 'Service Tax 6% 1.41']).items,
    ).toEqual([])
  })
})
