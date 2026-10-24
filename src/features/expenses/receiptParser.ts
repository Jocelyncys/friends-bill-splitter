import { parseMoneyToCents } from './expenseForm'

// Description, then a price at the end: "12.50", "12,50", "1,234.50", optionally "RM " prefixed.
const PRICE = /^(.+?)[\s:]+(?:RM\s*)?(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})$/i
const EXCLUDED = /^(subtotal|total|cash|change|tax|service|gst|sst)\b/i

export type ParsedReceiptItem = { description: string; totalCents: number }

/** OCR lines -> likely items. Money is parsed from text to integer cents; no float maths. */
export function parseReceiptLines(lines: string[]): ParsedReceiptItem[] {
  return lines.flatMap(line => {
    const match = line.trim().replace(/\s+/g, ' ').match(PRICE)
    if (!match) return []
    const description = match[1].trim()
    const totalCents = parseMoneyToCents(`${match[2].replace(/,/g, '')}.${match[3]}`)
    if (!description || EXCLUDED.test(description) || totalCents === null) return []
    return [{ description, totalCents }]
  })
}
