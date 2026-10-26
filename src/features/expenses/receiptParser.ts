import { parseMoneyToCents } from './expenseForm'

// Description, then a price at the end: "12.50", "12,50", "1,234.50", optionally "RM " prefixed.
const PRICE = /^(.+?)[\s:]+(?:RM\s*)?(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})$/i
// Bill-level lines, matched at the first letter so OCR noise ("* ", "- ") or a clipped first letter
// ("harges summary") does not let them through as items. Vouchers, discounts, tax, service charge and rounding
// are not read line by line (OCR gets them wrong on real photos): the Total line gives the amount paid instead.
const EXCLUDED =
  /^[^\p{L}]*(c?harges?\s+summary|base\s*amt|amount|qty|sub\s*-?\s*total|grand\s*total|member(?:ship)?\s*disc\w*|bill\s*rounding|voucher|disc\w*|rounding|tax\w*|gst|sst|service|svc|total|cash|change)\b/iu

// "Total (MYR) 25.00", "Grand Total 19.60"; not the subtotal or a total of discounts, quantity or items.
const TOTAL = /\btotal\b/i
const NOT_TOTAL = /sub\s*-?\s*total|total\s*(?:disc\w*|qty|quantity|items?|sav\w*)\b/i
const CURRENCY = /\(?\s*MYR\s*\)?|\bRM\b/i
const MONEY = /(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})(?!\d)/g

/** The amount on the receipt's Total line: the rightmost amount (OCR often prints it twice). */
function findTotal(lines: string[]): number | undefined {
  let found: { cents: number; currency: boolean } | undefined
  for (const line of lines) {
    if (!TOTAL.test(line) || NOT_TOTAL.test(line)) continue
    const last = [...line.matchAll(MONEY)].at(-1)
    const cents = last ? parseMoneyToCents(`${last[1].replace(/,/g, '')}.${last[2]}`) : null
    if (cents === null) continue
    const currency = CURRENCY.test(line)
    // A line with the currency wins; otherwise the lowest line (largest y) wins.
    if (!found || currency || !found.currency) found = { cents, currency }
  }
  return found?.cents
}

// Malaysian POS noise around an item name.
const REF_NOTE = /\s*[(（]\s*ref\s*:[^)）]*[)）]?/giu // "(ref: Member Discount)"
const UNIT_PRICE = /\s*[(（]\s*\d+[.,]\d{2}\s*\/\s*(?:ea\s*)?[)）]?/giu // "(2.20/ea)" or a dangling "(2.20/"
const DANGLING_EA = /\s+ea\s*[)）]\s*$/iu // "... ea)" left after the unit price was cut off
const QUANTITY = /^\d+\s+/u // "1 Fragrant Rice"

function cleanDescription(raw: string): string {
  return raw.replace(REF_NOTE, '').replace(UNIT_PRICE, '').replace(DANGLING_EA, '').trim().replace(QUANTITY, '').trim()
}

export type ParsedReceiptItem = { description: string; totalCents: number }
/**
 * OCR lines -> likely items, and the amount paid from the Total line (undefined when there is none).
 * Money is parsed from text to integer cents; no float maths.
 */
export function parseReceipt(lines: string[]): { items: ParsedReceiptItem[]; totalCents?: number } {
  const items: ParsedReceiptItem[] = []
  for (const line of lines) {
    const text = line.trim().replace(/\s+/g, ' ')
    if (EXCLUDED.test(text)) continue
    const match = text.match(PRICE)
    if (!match) continue
    const description = cleanDescription(match[1])
    const totalCents = parseMoneyToCents(`${match[2].replace(/,/g, '')}.${match[3]}`)
    if (!description || EXCLUDED.test(description) || totalCents === null) continue
    items.push({ description, totalCents })
  }
  const totalCents = findTotal(lines)
  return totalCents === undefined ? { items } : { items, totalCents }
}

/** Items only (see parseReceipt). */
export function parseReceiptLines(lines: string[]): ParsedReceiptItem[] {
  return parseReceipt(lines).items
}
