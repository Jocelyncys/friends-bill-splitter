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
})
