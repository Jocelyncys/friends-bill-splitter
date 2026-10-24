import { describe, expect, it } from 'vitest'
import { parseReceiptLines } from '../expenses/receiptParser'
import { groupIntoLines, type OcrBox } from './ocrLines'

const box = (text: string, x: number, y: number, w = 100, h = 30): OcrBox => ({
  text,
  poly: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]],
})

describe('groupIntoLines', () => {
  it('joins a description and its right-aligned price into one line', () => {
    // Shape of what PP-OCRv5 returned for e2e/fixtures/receipt.png.
    const boxes = [
      box('KEDAI MAKAN', 120, 10),
      box('Nasi Lemak', 30, 60),
      box('12.50', 380, 62),
      box('Teh Tarik', 30, 105),
      box('3.80', 390, 103),
      box('TOTAL', 30, 160),
      box('20.50', 380, 160),
    ]
    const lines = groupIntoLines(boxes)
    expect(lines).toEqual(['KEDAI MAKAN', 'Nasi Lemak 12.50', 'Teh Tarik 3.80', 'TOTAL 20.50'])
    expect(parseReceiptLines(lines)).toEqual([
      { description: 'Nasi Lemak', totalCents: 1250 },
      { description: 'Teh Tarik', totalCents: 380 },
    ])
  })

  it('orders cells left to right whatever order the detector returns them in', () => {
    expect(groupIntoLines([box('9.00', 300, 0), box('Kopi', 0, 2)])).toEqual(['Kopi 9.00'])
  })

  it('keeps closely spaced rows apart and skips empty boxes', () => {
    expect(groupIntoLines([box('A 1.00', 0, 0), box('', 0, 20), box('B 2.00', 0, 32)])).toEqual(['A 1.00', 'B 2.00'])
  })
})
