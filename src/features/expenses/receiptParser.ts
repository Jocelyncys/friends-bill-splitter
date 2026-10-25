import type { AdjustmentKind } from './expenseRepository'
import { parseMoneyToCents } from './expenseForm'

// Description, then a price at the end: "12.50", "12,50", "1,234.50", optionally "RM " prefixed.
const PRICE = /^(.+?)[\s:]+(?:RM\s*)?(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})$/i
// Bill-level lines, matched at the first letter so OCR noise ("* ", "- ") or a clipped first
// letter ("harges summary") does not let them through as items. Per-item member discounts are
// already reflected in the item prices, so they are neither items nor adjustments.
const EXCLUDED =
  /^[^\p{L}]*(c?harges?\s+summary|base\s*amt|amount|qty|sub\s*-?\s*total|grand\s*total|member(?:ship)?\s*disc\w*|bill\s*rounding|voucher|rounding|tax\w*|gst|sst|service|svc|total|cash|change)\b/iu

// Bill-level adjustments, by their first word(s). Longer names first so "discount" wins over "disc".
const ADJUSTMENT = /^[^\p{L}]*(bill\s*rounding|rounding|voucher|discount|disc|sst|gst|tax|service|svc)\b/iu
// The rightmost amount on the line, with its sign: "-5.00", "RM 10.00", "1,00".
const AMOUNT_AT_END = /(-)?\s*(?:RM\s*)?(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})\s*$/i
const KIND_BY_WORD: Array<[RegExp, AdjustmentKind]> = [
  [/rounding/i, 'rounding'],
  [/voucher|disc/i, 'discount'],
  [/sst|gst|tax/i, 'tax'],
  [/service|svc/i, 'service'],
]

// Malaysian POS noise around an item name.
const REF_NOTE = /\s*[(（]\s*ref\s*:[^)）]*[)）]?/giu // "(ref: Member Discount)"
const UNIT_PRICE = /\s*[(（]\s*\d+[.,]\d{2}\s*\/\s*(?:ea\s*)?[)）]?/giu // "(2.20/ea)" or a dangling "(2.20/"
const DANGLING_EA = /\s+ea\s*[)）]\s*$/iu // "... ea)" left after the unit price was cut off
const QUANTITY = /^\d+\s+/u // "1 Fragrant Rice"

function cleanDescription(raw: string): string {
  return raw.replace(REF_NOTE, '').replace(UNIT_PRICE, '').replace(DANGLING_EA, '').trim().replace(QUANTITY, '').trim()
}

/** "Voucher Discount: -5.0" -> "Voucher Discount": no leading noise, trailing colon or stray numbers. */
function cleanLabel(raw: string): string {
  let label = raw.replace(/^[^\p{L}]+/u, '')
  for (let before = ''; before !== label; ) {
    before = label
    label = label.replace(/[\s:]+$/u, '').replace(/\s*-?\d+(?:[.,]\d+)?$/u, '')
  }
  return label.slice(0, 60).trimEnd()
}

export type ParsedReceiptItem = { description: string; totalCents: number }
/** Signed integer cents: a voucher or discount is negative, rounding keeps the receipt's sign. */
export type ParsedAdjustment = { kind: AdjustmentKind; label: string; amountCents: number }

function parseAdjustment(text: string): ParsedAdjustment | null | undefined {
  const word = ADJUSTMENT.exec(text)?.[1]
  if (!word) return undefined // not an adjustment line
  const amount = AMOUNT_AT_END.exec(text)
  if (!amount) return null
  const cents = parseMoneyToCents(`${amount[2].replace(/,/g, '')}.${amount[3]}`)
  const label = cleanLabel(text.slice(0, amount.index))
  if (cents === null || !label) return null
  const kind = KIND_BY_WORD.find(([re]) => re.test(word))?.[1] ?? 'other'
  const sign = kind === 'discount' || (kind === 'rounding' && amount[1]) ? -1 : 1
  return { kind, label, amountCents: sign * cents }
}

/**
 * OCR lines -> likely items and bill-level adjustments (voucher, SST, service charge, rounding).
 * Money is parsed from text to integer cents; no float maths.
 */
export function parseReceipt(lines: string[]): { items: ParsedReceiptItem[]; adjustments: ParsedAdjustment[] } {
  const items: ParsedReceiptItem[] = []
  const adjustments: ParsedAdjustment[] = []
  for (const line of lines) {
    const text = line.trim().replace(/\s+/g, ' ')
    const adjustment = parseAdjustment(text)
    if (adjustment) adjustments.push(adjustment)
    if (adjustment !== undefined || EXCLUDED.test(text)) continue
    const match = text.match(PRICE)
    if (!match) continue
    const description = cleanDescription(match[1])
    const totalCents = parseMoneyToCents(`${match[2].replace(/,/g, '')}.${match[3]}`)
    if (!description || EXCLUDED.test(description) || totalCents === null) continue
    items.push({ description, totalCents })
  }
  return { items, adjustments }
}

/** Items only (see parseReceipt). */
export function parseReceiptLines(lines: string[]): ParsedReceiptItem[] {
  return parseReceipt(lines).items
}
