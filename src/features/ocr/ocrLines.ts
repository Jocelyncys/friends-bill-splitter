export type OcrBox = { text: string; poly: Array<[number, number]> }

/**
 * The OCR detector returns one box per run of text, so a receipt row with a right-aligned price comes back
 * as two boxes ("Nasi Lemak", "12.50"). Rebuild visual lines: boxes whose vertical centre falls inside the
 * row's band (half the smaller box height) join that row, left to right.
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

  const rows: Array<{ centre: number; height: number; cells: typeof placed }> = []
  for (const box of placed) {
    const row = rows[rows.length - 1]
    if (row && Math.abs(box.centre - row.centre) <= Math.min(box.height, row.height) / 2) row.cells.push(box)
    else rows.push({ centre: box.centre, height: box.height, cells: [box] })
  }
  return rows.map(row => row.cells.sort((a, b) => a.left - b.left).map(cell => cell.text).join(' '))
}
