import { parseMoneyToCents } from './expenseForm'

// Description, then a price at the end: "12.50", "12,50", "1,234.50", optionally "RM " prefixed.
const PRICE = /^(.+?)[\s:]+(?:RM\s*)?(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})$/i
// Bill-level lines, matched at the first letter so OCR noise ("* ", "- ") or a clipped first
// letter ("harges summary") does not let them through as items.
const EXCLUDED =
  /^[^\p{L}]*(c?harges?\s+summary|base\s*amt|amount|qty|sub\s*-?\s*total|voucher|rounding|tax|gst|sst|service|total|cash|change)\b/iu

// Malaysian POS noise around an item name.
const REF_NOTE = /\s*[(（]\s*ref\s*:[^)）]*[)）]?/giu // "(ref: Member Discount)"
const UNIT_PRICE = /\s*[(（]\s*\d+[.,]\d{2}\s*\/\s*(?:ea\s*)?[)）]?/giu // "(2.20/ea)" or a dangling "(2.20/"
const DANGLING_EA = /\s+ea\s*[)）]\s*$/iu // "... ea)" left after the unit price was cut off
const QUANTITY = /^\d+\s+/u // "1 Fragrant Rice"

function cleanDescription(raw: string): string {
  return raw.replace(REF_NOTE, '').replace(UNIT_PRICE, '').replace(DANGLING_EA, '').trim().replace(QUANTITY, '').trim()
}

export type ParsedReceiptItem = { description: string; totalCents: number }

/** OCR lines -> likely items. Money is parsed from text to integer cents; no float maths. */
export function parseReceiptLines(lines: string[]): ParsedReceiptItem[] {
  return lines.flatMap(line => {
    const text = line.trim().replace(/\s+/g, ' ')
    if (EXCLUDED.test(text)) return []
    const match = text.match(PRICE)
    if (!match) return []
    const description = cleanDescription(match[1])
    const totalCents = parseMoneyToCents(`${match[2].replace(/,/g, '')}.${match[3]}`)
    if (!description || EXCLUDED.test(description) || totalCents === null) return []
    return [{ description, totalCents }]
  })
}
