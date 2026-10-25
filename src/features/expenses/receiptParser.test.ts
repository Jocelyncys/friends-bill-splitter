import { describe, expect, it } from 'vitest'
import { parseReceiptLines } from './receiptParser'

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
