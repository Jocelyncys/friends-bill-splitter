// Hosts the PaddleOCR SDK off the main thread. The SDK's opencv build uses Function() (embind) when it is
// imported, which the page's Content-Security-Policy forbids; a worker loaded from its own URL is not
// governed by the page's <meta> CSP. The SDK then runs inference in its own nested worker as before.
import { findUntrustedAsset } from './assetGuard'
import { downloadAll } from './download'
import { groupIntoScoredLines } from './ocrLines'
import type { OcrAssets, OcrReply, OcrRequest } from './ocrEngine'
import type { OcrProgress } from './ocrProgress'

type Engine = { predict: (image: Blob) => Promise<{ items: { text: string; score: number; poly: Array<[number, number]> }[] }[]> }
let engine: Promise<Engine> | undefined

/**
 * Downloads the models and the runtime here, so the bytes can be counted (the SDK's own loader cannot report
 * progress, and its worker mode takes no custom fetch), then hands them to the SDK as blob: URLs. The files
 * still come only from this site's /ocr-models/ (checked by the asset guard before this runs).
 */
async function createEngine(assets: OcrAssets, report: (progress: OcrProgress) => void): Promise<Engine> {
  const sdk = import('@paddleocr/paddleocr-js')
  sdk.catch(() => undefined) // a failed import is reported when awaited below, not as an unhandled rejection
  let lastStep = ''
  const [det, rec, wasm] = await downloadAll(
    [{ url: assets.det }, { url: assets.rec }, { url: assets.wasm, type: 'application/wasm' }],
    progress => {
      // One message per whole percent (or file finished), not per network chunk.
      const step = Math.floor((progress.fraction ?? 0) * 100)
      const key = `${step}:${progress.filesDone}`
      if (key === lastStep) return
      lastStep = key
      report(progress)
    },
  )
  report({ stage: 'starting' })
  const urls = [det, rec, wasm].map(blob => URL.createObjectURL(blob))
  try {
    const { PaddleOCR } = await sdk
    return await PaddleOCR.create({
      lang: 'ch',
      ocrVersion: 'PP-OCRv5',
      worker: true,
      // The SDK requires the model name alongside a custom asset; these are what lang ch + PP-OCRv5 select.
      textDetectionModelName: 'PP-OCRv5_mobile_det',
      textDetectionModelAsset: { url: urls[0] },
      textRecognitionModelName: 'PP-OCRv5_mobile_rec',
      textRecognitionModelAsset: { url: urls[1] },
      ortOptions: {
        backend: 'wasm',
        numThreads: 2,
        simd: true,
        // onnxruntime-web accepts { wasm } here (the SDK passes it through); the SDK's typing says string.
        wasmPaths: { wasm: urls[2] } as unknown as string,
      },
    })
  } finally {
    // create() resolves after the SDK has read the models and compiled the runtime.
    for (const url of urls) URL.revokeObjectURL(url)
  }
}

addEventListener('message', async (event: MessageEvent<OcrRequest>) => {
  const [port] = event.ports
  const reply = (message: OcrReply) => port.postMessage(message)
  const untrusted = findUntrustedAsset(event.data.assets, self.location.origin)
  if (untrusted) return reply({ error: `Refusing OCR asset "${untrusted}" outside this site's /ocr-models/` })
  try {
    engine ??= createEngine(event.data.assets, progress => reply({ progress })).catch(err => {
      engine = undefined // allow retry after a failed load
      throw err
    })
    const ocr = await engine
    reply({ progress: { stage: 'reading' } })
    const [result] = await ocr.predict(event.data.image)
    reply({ lines: groupIntoScoredLines(result.items.filter(item => item.score >= 0.5)) })
  } catch (err) {
    reply({ error: err instanceof Error ? err.message : String(err) })
  }
})
