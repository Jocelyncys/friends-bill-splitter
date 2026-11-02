/**
 * What the receipt reader is doing. The OCR SDK (@paddleocr/paddleocr-js 0.4.2, worker mode) only exposes
 * create() and one predict() call, so the stages are: downloading the reader (real byte counts), starting it
 * (compiling the runtime, opening the models), reading the receipt (detection and recognition in one call, no
 * per-line events) and building the items (parsing, on the main thread).
 */
export type OcrProgress =
  | {
      stage: 'loading'
      loadedBytes: number
      /** 0 while any file's size is unknown (e.g. a compressed transfer has no Content-Length) */
      totalBytes: number
      filesDone: number
      files: number
      /** Mean of each file's share done: bytes over its size when known, else 0 or 1 when finished. */
      fraction?: number
    }
  | { stage: 'starting' }
  | { stage: 'reading' }
  | { stage: 'building' }

// Where each stage starts and ends on the bar. Loading the reader is the long part on a first scan.
const RANGE: Record<OcrProgress['stage'], [number, number]> = {
  loading: [0, 55],
  starting: [55, 65],
  reading: [65, 92],
  building: [92, 100],
}

/** One 0-100 value for the whole scan. Only loading moves inside its stage (by bytes, or by files done). */
export function progressPercent(progress: OcrProgress): number {
  const [from, to] = RANGE[progress.stage]
  if (progress.stage !== 'loading') return from
  const { loadedBytes, totalBytes, filesDone, files, fraction } = progress
  // A compressed transfer can deliver more bytes than its Content-Length: count files then.
  const share =
    fraction !== undefined ? fraction : totalBytes > 0 && loadedBytes <= totalBytes ? loadedBytes / totalBytes : files > 0 ? filesDone / files : 0
  return Math.round(from + (to - from) * Math.min(1, share))
}
