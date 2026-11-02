import type { OcrLine } from '../expenses/receiptParser'
import type { OcrProgress } from './ocrProgress'
import pins from './ocrPins.json'

export type OcrAssets = ReturnType<typeof ocrAssetUrls>
export type OcrRequest = { assets: OcrAssets; image: Blob }
export type OcrReply = { progress: OcrProgress } | { lines: OcrLine[] } | { error: string }

/**
 * Self-hosted OCR assets (downloaded by scripts/fetch-ocr-models.mjs into public/ocr-models/).
 * URLs are made absolute against the page because they are fetched inside workers,
 * where relative URLs would resolve against the worker script in assets/.
 */
export function ocrAssetUrls(base: string = document.baseURI) {
  const url = (path: string) => new URL(`ocr-models/${path}`, base).href
  return {
    det: url(pins.det.file),
    rec: url(pins.rec.file),
    // The SDK's inference worker embeds onnxruntime-web 1.24.3 glue; only the matching wasm binary is fetched.
    wasm: url(pins.wasm.file),
  }
}

let worker: Worker | undefined
let engineReady = false

const ASSET_COUNT = 3 // det model, rec model, runtime wasm

/**
 * Runs PaddleOCR entirely in the browser, in a dedicated worker (see ocr.worker.ts), so the SDK never
 * loads on the main thread. Progress: the reader's download in bytes, then starting it, then reading the
 * receipt (see ocrProgress.ts). All model and runtime files come from our own origin.
 */
export function recognizeReceipt(file: File, onProgress?: (progress: OcrProgress) => void): Promise<OcrLine[]> {
  onProgress?.(engineReady ? { stage: 'reading' } : { stage: 'loading', loadedBytes: 0, totalBytes: 0, filesDone: 0, files: ASSET_COUNT })
  const current = (worker ??= new Worker(new URL('./ocr.worker.ts', import.meta.url), { type: 'module' }))
  const { port1, port2 } = new MessageChannel()
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => {
      current.removeEventListener('error', onCrash)
      port1.close()
      fn()
    }
    // The worker script failed to load or threw outside a request: start a fresh worker next time.
    const onCrash = (event: ErrorEvent) => {
      current.terminate()
      if (worker === current) worker = undefined
      settle(() => reject(new Error(event.message || 'OCR worker failed')))
    }
    current.addEventListener('error', onCrash)
    port1.onmessage = ({ data }: MessageEvent<OcrReply>) => {
      if ('progress' in data) {
        if (data.progress.stage === 'reading') engineReady = true
        onProgress?.(data.progress)
      } else if ('error' in data) {
        settle(() => reject(new Error(data.error)))
      } else {
        settle(() => resolve(data.lines))
      }
    }
    current.postMessage({ assets: ocrAssetUrls(), image: file } satisfies OcrRequest, [port2])
  })
}
