import { describe, expect, it } from 'vitest'
import { classifyReceiptLine, parseReceipt, parseReceiptLines } from './receiptParser'

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

const pick = (items: ReturnType<typeof parseReceipt>['items']) =>
  items.map(i => [i.description, i.quantity, i.unitCents, i.totalCents])

describe('parseReceipt quantities', () => {
  it.each([
    ['2 Teh Ais 7.00', 'Teh Ais', 2, 350, 700],
    ['2x Teh O 4.00', 'Teh O', 2, 200, 400],
    ['2 x Teh O 4.00', 'Teh O', 2, 200, 400],
    ['Roti Canai x2 3.00', 'Roti Canai', 2, 150, 300],
    ['Fried Rice 2 @ 12.00 24.00', 'Fried Rice', 2, 1200, 2400],
    ['Milo Ais 2 x 4.20 8.40', 'Milo Ais', 2, 420, 840],
    ['Chinese Tea 3 1.50 4.50', 'Chinese Tea', 3, 150, 450],
    ['Kopi Peng 3.50 7.00', 'Kopi Peng', 2, 350, 700],
    ['Teh Ais Qty 2 7.00', 'Teh Ais', 2, 350, 700],
    ['Qty: 2 Teh Ais 7.00', 'Teh Ais', 2, 350, 700],
    ['2 Iced Lemon Tea (4.32/ea) 8.64', 'Iced Lemon Tea', 2, 432, 864],
    ['1 Fragrant Rice香米白饭（2.20/ 2.20', 'Fragrant Rice香米白饭', 1, 220, 220],
    ['Nasi Lemak 12.50 12.50', 'Nasi Lemak', 1, 1250, 1250],
  ])('reads %j', (line, description, quantity, unitCents, totalCents) => {
    expect(pick(parseReceipt([line]).items)).toEqual([[description, quantity, unitCents, totalCents]])
  })

  it('keeps the printed total when quantity x unit price disagrees, and flags the row', () => {
    const [item] = parseReceipt(['2 Teh Ais (3.50/ea) 7.50']).items
    expect(item).toMatchObject({ description: 'Teh Ais', quantity: 2, totalCents: 750, lowConfidence: true })
  })

  it('does not read a big leading number as a quantity without a unit price to back it', () => {
    expect(pick(parseReceipt(['100 Plus 2.50']).items)).toEqual([['100 Plus', 1, 250, 250]])
  })

  it('joins a name line with a quantity line printed under it', () => {
    expect(pick(parseReceipt(['Teh Ais', '2 x 3.50 7.00', 'Kopi O 2.20']).items)).toEqual([
      ['Teh Ais', 2, 350, 700],
      ['Kopi O', 1, 220, 220],
    ])
  })
})

describe('parseReceipt line types', () => {
  it.each([
    ['Subtotal 10.00', 'subtotal'],
    ['5ubtota1 18.40', 'subtotal'],
    ['Sub-Total: 66.50', 'subtotal'],
    ['Service Charge 10% 6.65', 'service'],
    ['Svc Chg 1.50', 'service'],
    ['SST 6% 3.99', 'tax'],
    ['SST6% 0.63', 'tax'],
    ['GST 0.60', 'tax'],
    ['Service Tax 6% 1.41', 'tax'],
    ['Voucher -5.00', 'discount'],
    ['youcher Discount: -5.0', 'discount'],
    ['Member Discount 0.96', 'discount'],
    ['Rounding -0.02', 'rounding'],
    ['Bil rounding 0.02', 'rounding'],
    ['Grand Total 77.15', 'total'],
    ['T0TAL RM 19.00', 'total'],
    ['Amount Due 12.00', 'total'],
    ['Cash 50.00', 'payment'],
    ['Change 5.30', 'payment'],
    ['VISA 77.15', 'payment'],
    ['DuitNow QR 25.00', 'payment'],
    ['Tel: 03-7876 5432', 'junk'],
    ['No. 12, Jalan SS2/24, 47300 Petaling Jaya', 'junk'],
    ['Invoice No: INV-000123', 'junk'],
    ['Date: 02/11/2026 08:15', 'junk'],
    ['www.selerakampung.my', 'junk'],
    ['Thank you, come again!', 'junk'],
    ['TAX INVOICE', 'junk'],
    ['Teh Ais 3.50', 'item'],
  ])('%j is %s', (line, kind) => {
    expect(classifyReceiptLine(line)).toBe(kind)
  })
})

describe('realistic Malaysian receipts', () => {
  it('kopitiam: leading quantities, header and footer ignored, merchant name', () => {
    const receipt = parseReceipt([
      'KEDAI KOPI SIN HUAT',
      'No. 12, Jalan SS2/24, 47300 Petaling Jaya',
      'Tel: 03-7876 5432',
      'Date: 02/11/2026 08:15 Table: 7',
      '2 Teh Ais 7.00',
      '1 Kopi O 2.20',
      '3 Roti Bakar 3.00 9.00',
      'Nasi Lemak Biasa 6.50',
      'Total RM 24.70',
      'Cash 30.00',
      'Change 5.30',
      'Thank you, come again!',
    ])
    expect(pick(receipt.items)).toEqual([
      ['Teh Ais', 2, 350, 700],
      ['Kopi O', 1, 220, 220],
      ['Roti Bakar', 3, 300, 900],
      ['Nasi Lemak Biasa', 1, 650, 650],
    ])
    expect(receipt.totalCents).toBe(2470)
    expect(receipt.merchant).toBe('KEDAI KOPI SIN HUAT')
    expect(receipt.warnings).toEqual([])
  })

  it('mamak: x2 quantities and a subtotal that matches', () => {
    const receipt = parseReceipt([
      'RESTORAN NASI KANDAR PELITA',
      'Roti Canai x2 3.00',
      'Teh Tarik x2 5.60',
      'Maggi Goreng 7.50',
      'Milo Ais 2 x 4.20 8.40',
      'SUBTOTAL 24.50',
      'TOTAL 24.50',
    ])
    expect(pick(receipt.items)).toEqual([
      ['Roti Canai', 2, 150, 300],
      ['Teh Tarik', 2, 280, 560],
      ['Maggi Goreng', 1, 750, 750],
      ['Milo Ais', 2, 420, 840],
    ])
    expect(receipt.subtotalCents).toBe(2450)
    expect(receipt.totalCents).toBe(2450)
    expect(receipt.merchant).toBe('RESTORAN NASI KANDAR PELITA')
    expect(receipt.warnings).toEqual([])
  })

  it('restaurant: service 10%, SST 6% and rounding stay out of the items; the grand total is paid', () => {
    const receipt = parseReceipt([
      'DRAGON PALACE RESTAURANT',
      'Invoice No: INV-000123',
      'Fried Rice 2 @ 12.00 24.00',
      'Sweet Sour Fish 38.00',
      'Chinese Tea 3 1.50 4.50',
      'Sub Total 66.50',
      'Service Charge 10% 6.65',
      'SST 6% 3.99',
      'Rounding 0.01',
      'Grand Total 77.15',
      'VISA 77.15',
    ])
    expect(pick(receipt.items)).toEqual([
      ['Fried Rice', 2, 1200, 2400],
      ['Sweet Sour Fish', 1, 3800, 3800],
      ['Chinese Tea', 3, 150, 450],
    ])
    expect(receipt.subtotalCents).toBe(6650)
    expect(receipt.totalCents).toBe(7715)
    expect(receipt.warnings).toEqual([])
  })

  it('noisy: OCR-mangled keywords, a subtotal that does not match, two different totals and a low-confidence row', () => {
    const receipt = parseReceipt([
      { text: '*** SELERA KAMPUNG ***', confidence: 0.97 },
      { text: 'www.selerakampung.my', confidence: 0.9 },
      { text: 'Ayam Penyet 12.90', confidence: 0.96 },
      { text: 'Es Teh 2.50', confidence: 0.95 },
      { text: 'Kerupuk 1.00', confidence: 0.62 },
      { text: '5ubtota1 18.40', confidence: 0.8 },
      { text: 'TOTAL 18.40', confidence: 0.93 },
      { text: 'T0TAL RM 19.00', confidence: 0.7 },
    ])
    expect(pick(receipt.items)).toEqual([
      ['Ayam Penyet', 1, 1290, 1290],
      ['Es Teh', 1, 250, 250],
      ['Kerupuk', 1, 100, 100],
    ])
    expect(receipt.items.map(i => i.lowConfidence ?? false)).toEqual([false, false, true])
    expect(receipt.merchant).toBe('SELERA KAMPUNG')
    expect(receipt.totalCents).toBe(1900)
    expect(receipt.warnings).toEqual([
      { kind: 'subtotal_mismatch', itemsCents: 1640, subtotalCents: 1840 },
      { kind: 'multiple_totals' },
    ])
  })

  it('the real receipt: quantities, no merchant line, and no warnings', () => {
    const receipt = parseReceipt([
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
    ])
    expect(receipt.items.map(i => [i.quantity, i.totalCents])).toEqual([[1, 220], [1, 891], [1, 531], [2, 864], [1, 351]])
    expect(receipt.totalCents).toBe(2500)
    expect(receipt.merchant).toBeUndefined()
    expect(receipt.warnings).toEqual([])
  })

  it('warns when there are items but no total line', () => {
    expect(parseReceipt(['Teh Ais 3.50']).warnings).toEqual([{ kind: 'no_total' }])
    expect(parseReceipt(['THANK YOU']).warnings).toEqual([])
  })
})
