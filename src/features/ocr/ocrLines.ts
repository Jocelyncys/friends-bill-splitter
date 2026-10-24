export type OcrBox = { text: string; poly: Array<[number, number]> }

/** Share of the median box height a box's centre may sit from a row's running centre and still join it. */
const ROW_TOLERANCE = 0.6

/**
 * The OCR detector returns one box per run of text, so a receipt row with a right-aligned price comes back
 * as two boxes ("Nasi Lemak", "12.50"). Rebuild visual lines: walking boxes top to bottom, a box joins the
 * current row when its vertical centre is within 0.6 × the median box height of the row's running (mean)
 * centre, which also tolerates a slightly tilted photo. Each row reads left to right.
 */
export function groupIntoLines(boxes: OcrBox[]): string[] {
  const placed = boxes
    .filter(box => box.poly.length > 0 && box.text.trim() !== '')
    .map(box => {
      const ys = box.poly.map(([, y]) => y)
      const top = Math.min(...ys)
      const bottom = Math.max(...ys)
      return { text: box.text.trim(), left: Math.min(...box.poly.map(([x]) => x)), centre: (top + bottom) / 2, height: bottom - top }
    })
    .sort((a, b) => a.centre - b.centre)

  // Degenerate (zero-height) polygons do not count towards the typical height; with none usable, rows only
  // merge on an identical centre.
  const heights = placed.map(box => box.height).filter(h => h > 0).sort((a, b) => a - b)
  const tolerance = heights.length > 0 ? ROW_TOLERANCE * heights[Math.floor(heights.length / 2)] : 0

  const rows: Array<{ centreSum: number; cells: typeof placed }> = []
  for (const box of placed) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(box.centre - row.centreSum / row.cells.length) <= tolerance) {
      row.cells.push(box)
      row.centreSum += box.centre
    } else {
      rows.push({ centreSum: box.centre, cells: [box] })
    }
  }
  return rows.map(row => row.cells.sort((a, b) => a.left - b.left).map(cell => cell.text).join(' '))
}
