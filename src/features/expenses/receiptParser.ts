import { parseMoneyToCents } from './expenseForm'

// Receipt OCR lines -> items (with quantities), the amount paid (Total line), the subtotal, the merchant name and
// warnings for the review screen. Money is parsed from text to integer cents; no float maths.

/** One recognised line; confidence is the lowest OCR score of its boxes (0..1), when known. */
export type OcrLine = { text: string; confidence?: number }

export type ParsedReceiptItem = {
  description: string
  quantity: number
  /** Price of one unit, when it is known (printed, or the total divides evenly). */
  unitCents?: number
  /** The line total: what the receipt charged for this row. */
  totalCents: number
  /** OCR was unsure about this row, or its quantity, unit price and total disagree. */
  lowConfidence?: boolean
}

export type ReceiptWarning =
  | { kind: 'subtotal_mismatch'; itemsCents: number; subtotalCents: number }
  | { kind: 'multiple_totals' }
  | { kind: 'no_total' }

export type ParsedReceipt = {
  items: ParsedReceiptItem[]
  /** The amount paid, from the Total line. */
  totalCents?: number
  subtotalCents?: number
  /** Shop name from the top lines, for a blank description. */
  merchant?: string
  warnings: ReceiptWarning[]
}

export type ReceiptLineKind =
  | 'item'
  | 'subtotal'
  | 'service'
  | 'tax'
  | 'discount'
  | 'rounding'
  | 'total'
  | 'payment'
  | 'summary'
  | 'junk'

/** Below this OCR score a row is highlighted for checking. */
const LOW_CONFIDENCE = 0.8
/** A plain leading number ("2 Teh Ais") is only read as a quantity up to this, unless a unit price backs it. */
const MAX_UNCONFIRMED_QUANTITY = 20
const MAX_QUANTITY = 999

const MONEY_SRC = String.raw`(\d{1,3}(?:,\d{3})+|\d+)[.,](\d{2})`
const MONEY = new RegExp(`${MONEY_SRC}(?!\\d)`, 'g')
// Description, then a price at the end: "12.50", "12,50", "1,234.50", optionally "RM " prefixed.
const PRICE = new RegExp(`^(.+?)[\\s:]+(?:RM\\s*)?${MONEY_SRC}$`, 'i')

// ---- line classification (OCR-noise tolerant) ----
// Bill-level words are matched at the start of the line, after any non-letters ("* ", "- ", "5 "), so an item
// such as "Century Egg (ref: Member Discount)" is not taken for a discount. Common OCR swaps are allowed:
// 0/o, 1/l/i, 5/s, v/y.
const T = String.raw`t[o0]ta[l1i]`
const SUBTOTAL = new RegExp(String.raw`^[s5][uv]b\s*-?\s*${T}`, 'i')
const TOTAL_START = new RegExp(String.raw`^(?:grand\s*|nett?\s*)?${T}\b|^amount\s*(?:due|payable)\b|^jumlah\b|^nett\b`, 'i')
const NOT_TOTAL_REST = new RegExp(String.raw`^(?:grand\s*)?${T}\s*(?:(disc\w*|sav\w*)|(qty|quantity|items?))\b`, 'i')
const TAX_ANYWHERE = /\b(?:tax|cukai)\b|(?:^|[^a-z])(?:sst|gst)(?=\b|\d|\()/i
const SERVICE = /^(?:serv[il1]ce|svc|s\/c\b|caj\s*perkhidmatan)/i
const TAX_START = /^(?:tax\w*|cukai|sst|gst)/i
const DISCOUNT = /^(?:disc\w*|[vy]ou?cher|[vy]oucher|promo\w*|coupon|member(?:ship)?\s*disc\w*|member\s*price|less\b|potongan)/i
const ROUNDING = /^(?:bill?\s*)?round\w*|^pembundaran|^adj\w*\s*round/i
const PAYMENT =
  /^(?:cash|tunai|change|baki|card|credit|debit|visa|master\w*|amex|duit\s*now|tng|touch\s*'?n\s*go|grab\s*pay|boost|e-?wallet|paid|tender\w*|payment|bayaran|qr\s*pay|shopee\s*pay)\b/i
const SUMMARY = /^(?:c?harges?\s+summary|base\s*amt|amount\b|qty\b)/i
const JUNK = [
  /\b(?:tel|phone|fax|hp|whatsapp)\b\s*[:.]?/i,
  /\+?\b6?0\d{1,2}[- ]?\d{3,4}[- ]?\d{4}\b/, // Malaysian phone numbers
  /\b(?:jalan|jln|lorong|lrg|taman|tmn|persiaran|lebuh|bandar|kampung\s+\w+\s*,)\b|\bno\.?\s*\d+\s*,|\blot\s*\d|\b\d{5}\s+\p{L}/iu,
  /\b(?:invoice|inv\s*no|receipt|rcpt|bill\s*no|order\s*(?:no|#)|cashier|server|counter|terminal|trans(?:action)?\s*(?:no|id)|ref\s*no|reg(?:istration)?\s*no|co\.?\s*no|sdn\.?\s*bhd|bhd\b|enterprise)\b/i,
  /\b(?:sst|gst)\s*(?:id|reg\w*|no)\b/i,
  /(?:in)?voice\s*(?:no|#)|\bno\s*[:.#]\s*\d{4,}/i, // OCR often clips the "In" off "Invoice no: 127230"
  /\btable\s*(?:no\.?|#)?\s*:?\s*\d|\bpax\s*:?\s*\d/i,
  /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\b|\b(?:date|time|tarikh|masa)\b\s*:?/i,
  /www\.|https?:|\.com\b|\.my\b|@\w+\.\w/i,
  /thank\s*you|terima\s*kasih|come\s*again|please\s*come|powered\s*by|wi-?fi|password|follow\s*us|goods\s*sold|no\s*refund/i,
]

const leadingNoise = (text: string) => text.replace(/^[^\p{L}]*/u, '')

/** What a receipt line is. Anything not recognised as bill-level, payment or header/footer text is an 'item'. */
export function classifyReceiptLine(raw: string): ReceiptLineKind {
  const text = raw.trim().replace(/\s+/g, ' ')
  const start = leadingNoise(text)
  // "5ubtota1": a 5 standing in for the S is kept for this one check.
  if (SUBTOTAL.test(start) || SUBTOTAL.test(text.replace(/^[^\p{L}\p{N}]*/u, ''))) return 'subtotal'
  const notTotal = start.match(NOT_TOTAL_REST)
  if (notTotal) return notTotal[1] ? 'discount' : 'summary'
  if (TOTAL_START.test(start)) return 'total'
  // "TAX INVOICE", "SST ID ..." are header text, not a tax line.
  if (JUNK.some(re => re.test(text))) return 'junk'
  if (SERVICE.test(start)) return TAX_ANYWHERE.test(start) ? 'tax' : 'service'
  if (TAX_START.test(start)) return 'tax'
  if (DISCOUNT.test(start)) return 'discount'
  if (ROUNDING.test(start)) return 'rounding'
  if (PAYMENT.test(start)) return 'payment'
  // "Qty 3.00" is a summary; "Qty: 2 Teh Ais 7.00" is an item.
  if (SUMMARY.test(start) && !/^qty\s*:?\s*\d{1,3}\s+\p{L}/iu.test(start)) return 'summary'
  return 'item'
}

// ---- amounts ----

const toCents = (whole: string, decimals: string) => parseMoneyToCents(`${whole.replace(/,/g, '')}.${decimals}`)

/** The rightmost amount on a line (OCR often prints it twice). */
function lastAmount(line: string): number | null {
  const last = [...line.matchAll(MONEY)].at(-1)
  return last ? toCents(last[1], last[2]) : null
}

// "Total (MYR) 25.00", "Grand Total 19.60", "T0TAL RM 19.00"; not the subtotal or a total of discounts, quantity or items.
const TOTAL_ANYWHERE = new RegExp(String.raw`\b(?:${T}|amount\s*due|jumlah)\b`, 'i')
const NOT_TOTAL = new RegExp(String.raw`[s5][uv]b\s*-?\s*${T}|${T}\s*(?:disc\w*|qty|quantity|items?|sav\w*)\b`, 'i')
const CURRENCY = /\(?\s*MYR\s*\)?|\bRM\b/i

/** Every Total line's amount; a line with the currency wins, otherwise the lowest line (largest y). */
function findTotals(lines: string[]): { totalCents?: number; amounts: number[] } {
  let found: { cents: number; currency: boolean } | undefined
  const amounts: number[] = []
  for (const line of lines) {
    if (!TOTAL_ANYWHERE.test(line) || NOT_TOTAL.test(line)) continue
    const cents = lastAmount(line)
    if (cents === null) continue
    amounts.push(cents)
    const currency = CURRENCY.test(line)
    if (!found || currency || !found.currency) found = { cents, currency }
  }
  return { totalCents: found?.cents, amounts }
}

// ---- items ----

// Malaysian POS noise around an item name.
const REF_NOTE = /\s*[(（]\s*ref\s*[:;][^)）]*[)）]?/giu // "(ref: Member Discount)"
const UNIT_PRICE = new RegExp(String.raw`\s*[(（]\s*${MONEY_SRC}\s*\/\s*(?:ea\s*)?[)）]?`, 'iu') // "(2.20/ea)" or "(2.20/"
const DANGLING_EA = /\s+ea\s*[)）]\s*$/iu // "... ea)" left after the unit price was cut off
const QTY_TIMES_UNIT = new RegExp(String.raw`(?:^|\s)(\d{1,3})\s*[x×@]\s*(?:RM\s*)?${MONEY_SRC}$`, 'i') // "2 x 4.20", "2 @ 12.00"
const AT_UNIT = new RegExp(String.raw`\s*@\s*(?:RM\s*)?${MONEY_SRC}$`, 'i') // "@ 3.50"
const QTY_SPACE_UNIT = new RegExp(String.raw`\s(\d{1,3})\s+(?:RM\s*)?${MONEY_SRC}$`, 'i') // "3 1.50"
const UNIT_SPACE_QTY = new RegExp(String.raw`\s(?:RM\s*)?${MONEY_SRC}\s+(\d{1,3})$`, 'i') // "2.20 2"
const TRAILING_UNIT = new RegExp(String.raw`\s(?:RM\s*)?${MONEY_SRC}$`, 'i') // "3.50" before the total
const TRAILING_X_QTY = /\s[x×]\s*(\d{1,3})$/i // "x2"
const QTY_WORD = /\bqty\s*[:.]?\s*(\d{1,3})\b/i // "Qty 2", "Qty: 2"
const LEADING_X_QTY = /^(\d{1,3})\s*[x×](?:\s+|(?=\p{L}))/iu // "2x ", "2 x "
const LEADING_QTY = /^(\d{1,3})\s+(?=\p{L})/u // "2 Teh Ais" (not confirmed on its own)

type Parts = { description: string; quantity?: number; strongQuantity: boolean; unitCents?: number }

/** Takes quantity and unit-price markers off the text before the line total. */
function splitQuantity(head: string, totalCents: number): Parts {
  let text = head.replace(REF_NOTE, '').trim()
  let quantity: number | undefined
  let strongQuantity = false
  let unitCents: number | undefined
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = text.match(re)
    if (!m) return false
    fn(m)
    text = (text.slice(0, m.index) + text.slice((m.index ?? 0) + m[0].length)).trim()
    return true
  }
  // Right end: "2 x 4.20", "@ 3.50", "3 1.50" or a lone unit price "3.50" (the first that matches).
  const qtyAndUnit = (m: RegExpMatchArray) => {
    quantity = Number(m[1])
    strongQuantity = true
    unitCents = toCents(m[2], m[3]) ?? undefined
  }
  const unitOnly = (m: RegExpMatchArray) => {
    unitCents = toCents(m[1], m[2]) ?? undefined
  }
  // "Milo Dinosaur 2.20 2": a quantity only when unit x quantity fits the total; otherwise the number belongs to
  // the name ("Coke 1.50 330", "Room 12.00 101") and goes back into it.
  let nameNumber: string | undefined
  const unitAndQty = (m: RegExpMatchArray) => {
    unitCents = toCents(m[1], m[2]) ?? undefined
    const q = Number(m[3])
    if (unitCents !== undefined && q >= 1 && Math.abs(q * unitCents - totalCents) * 2 <= q) {
      quantity = q
      strongQuantity = true
    } else nameNumber = m[3]
  }
  const rightEnd: Array<[RegExp, (m: RegExpMatchArray) => void]> = [
    [QTY_TIMES_UNIT, qtyAndUnit],
    [AT_UNIT, unitOnly],
    [QTY_SPACE_UNIT, qtyAndUnit],
    [UNIT_SPACE_QTY, unitAndQty],
    [TRAILING_UNIT, unitOnly],
  ]
  rightEnd.some(([re, fn]) => take(re, fn))
  if (nameNumber !== undefined) text = `${text} ${nameNumber}`
  // "(4.32/ea)" anywhere.
  take(UNIT_PRICE, m => (unitCents ??= toCents(m[1], m[2]) ?? undefined))
  text = text.replace(DANGLING_EA, '').trim()
  // Quantity words: "x2", "Qty 2", "2x", then a plain leading "2".
  if (quantity === undefined) {
    if (take(TRAILING_X_QTY, m => (quantity = Number(m[1])))) {
      strongQuantity = true
      // "Kopi O 1.80 x2": the unit price sits before the x2.
      if (unitCents === undefined) take(TRAILING_UNIT, unitOnly)
    } else if (
      take(QTY_WORD, m => (quantity = Number(m[1]))) ||
      take(LEADING_X_QTY, m => (quantity = Number(m[1])))
    ) {
      strongQuantity = true
    } else {
      const m = text.match(LEADING_QTY)
      if (m) {
        quantity = Number(m[1])
        text = text.slice(m[0].length).trim()
      }
    }
  }
  return { description: text, quantity, strongQuantity, unitCents }
}

/** Decides quantity and unit price from what was printed; the line total always wins. */
function resolveItem(head: string, totalCents: number): Omit<ParsedReceiptItem, 'lowConfidence'> & { unsure: boolean } {
  const parts = splitQuantity(head, totalCents)
  let { quantity, unitCents } = parts
  let description = parts.description
  let unsure = false
  const fits = (q: number, unit: number) => Math.abs(q * unit - totalCents) * 2 <= q
  if (quantity !== undefined && (quantity < 1 || quantity > MAX_QUANTITY)) quantity = undefined

  if (quantity !== undefined && unitCents !== undefined && !fits(quantity, unitCents)) {
    const k = unitCents > 0 && totalCents % unitCents === 0 ? totalCents / unitCents : 0
    if (!parts.strongQuantity && k >= 1 && k <= MAX_QUANTITY) {
      // "7 Up 1.50 3.00": the leading number was part of the name.
      description = `${quantity} ${description}`
      quantity = k
    } else {
      unsure = true
      unitCents = undefined
    }
  } else if (quantity === undefined && unitCents !== undefined) {
    const k = unitCents > 0 && totalCents % unitCents === 0 ? totalCents / unitCents : 0
    if (k >= 1 && k <= MAX_QUANTITY) quantity = k
    else {
      unsure = true // two amounts that do not fit together
      unitCents = undefined
    }
  } else if (quantity !== undefined && unitCents === undefined && !parts.strongQuantity && quantity > 1) {
    // A plain leading number with no unit price to back it ("2 Teh Ais 7.00"): a quantity only when it divides the
    // total and is small; then the row is flagged so the user checks it. Otherwise it is part of the name
    // ("7 Up 3.00", "100 Plus 2.50").
    if (quantity <= MAX_UNCONFIRMED_QUANTITY && totalCents % quantity === 0) unsure = true
    else {
      description = `${quantity} ${description}`
      quantity = undefined
    }
  }

  const q = quantity ?? 1
  if (unitCents === undefined && totalCents % q === 0) unitCents = totalCents / q
  return { description: description.replace(/\s+/g, ' ').trim(), quantity: q, unitCents, totalCents, unsure }
}

// A quantity line printed under its name: "2 x 3.50 7.00".
const QTY_LINE = new RegExp(String.raw`^(\d{1,3})\s*[x×@]\s*(?:RM\s*)?${MONEY_SRC}\s+(?:RM\s*)?${MONEY_SRC}$`, 'i')

const MERCHANT_LOOKAHEAD = 4

function cleanMerchant(text: string): string | undefined {
  const name = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}).]+$/gu, '').replace(/\s+/g, ' ').trim()
  return name.length >= 2 && name.length <= 60 && (name.match(/\p{L}/gu)?.length ?? 0) >= 3 ? name : undefined
}

/**
 * OCR lines -> items with quantities, the amount paid from the Total line (undefined when there is none), the
 * subtotal, the merchant and warnings. Nothing is changed silently: a subtotal that does not match the items only
 * adds a warning.
 */
export function parseReceipt(input: Array<string | OcrLine>): ParsedReceipt {
  const lines = input.map(line => (typeof line === 'string' ? { text: line } : line))
  const texts = lines.map(line => line.text.trim().replace(/\s+/g, ' '))
  const items: ParsedReceiptItem[] = []
  let merchant: string | undefined
  let subtotalCents: number | undefined
  let pendingName: { text: string; confidence?: number } | undefined
  let seenPrice = false

  texts.forEach((text, index) => {
    const confidence = lines[index].confidence
    const kind = classifyReceiptLine(text)
    const hasMoney = lastAmount(text) !== null
    if (kind === 'subtotal' && subtotalCents === undefined && hasMoney) subtotalCents = lastAmount(text) ?? undefined
    if (kind !== 'item') {
      if (hasMoney) seenPrice = true
      pendingName = undefined
      return
    }
    const qtyLine = text.match(QTY_LINE)
    if (qtyLine && pendingName) {
      const totalCents = toCents(qtyLine[4], qtyLine[5])
      if (totalCents !== null) {
        const item = resolveItem(`${pendingName.text} ${qtyLine[1]} x ${qtyLine[2]}.${qtyLine[3]}`, totalCents)
        pushItem(item, Math.min(pendingName.confidence ?? 1, confidence ?? 1))
      }
      pendingName = undefined
      seenPrice = true
      return
    }
    const match = text.match(PRICE)
    if (!match) {
      // A name with its price on the next line, or the shop name at the top.
      const hasLetters = /\p{L}{2}/u.test(text)
      pendingName = hasLetters ? { text, confidence } : undefined
      if (!seenPrice && merchant === undefined && index < MERCHANT_LOOKAHEAD && hasLetters) merchant = cleanMerchant(text)
      return
    }
    seenPrice = true
    pendingName = undefined
    const totalCents = toCents(match[2], match[3])
    if (totalCents === null) return
    pushItem(resolveItem(match[1], totalCents), confidence)
  })

  function pushItem(item: ReturnType<typeof resolveItem>, confidence: number | undefined) {
    const { unsure, ...rest } = item
    if (!rest.description || !/\p{L}/u.test(rest.description) || classifyReceiptLine(rest.description) !== 'item') return
    const low = unsure || (confidence !== undefined && confidence < LOW_CONFIDENCE)
    items.push(low ? { ...rest, lowConfidence: true } : rest)
  }

  const { totalCents, amounts } = findTotals(texts)
  const warnings: ReceiptWarning[] = []
  const itemsCents = items.reduce((sum, item) => sum + item.totalCents, 0)
  if (subtotalCents !== undefined && items.length > 0 && itemsCents !== subtotalCents) {
    warnings.push({ kind: 'subtotal_mismatch', itemsCents, subtotalCents })
  }
  if (new Set(amounts).size > 1) warnings.push({ kind: 'multiple_totals' })
  if (totalCents === undefined && items.length > 0) warnings.push({ kind: 'no_total' })

  return {
    items,
    ...(totalCents !== undefined ? { totalCents } : {}),
    ...(subtotalCents !== undefined ? { subtotalCents } : {}),
    ...(merchant !== undefined ? { merchant } : {}),
    warnings,
  }
}

/** Items only, as { description, totalCents } (see parseReceipt). */
export function parseReceiptLines(lines: Array<string | OcrLine>): Array<{ description: string; totalCents: number }> {
  return parseReceipt(lines).items.map(({ description, totalCents }) => ({ description, totalCents }))
}
