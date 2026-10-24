// Hosts the PaddleOCR SDK off the main thread. The SDK's opencv build uses Function() (embind) when it is
// imported, which the page's Content-Security-Policy forbids; a worker loaded from its own URL is not
// governed by the page's <meta> CSP. The SDK then runs inference in its own nested worker as before.
import { findUntrustedAsset } from './assetGuard'
import { groupIntoLines } from './ocrLines'
import type { OcrAssets, OcrReply, OcrRequest } from './ocrEngine'

type Engine = { predict: (image: Blob) => Promise<{ items: { text: string; score: number; poly: Array<[number, number]> }[] }[]> }
let engine: Promise<Engine> | undefined

function createEngine(assets: OcrAssets): Promise<Engine> {
  return import('@paddleocr/paddleocr-js').then(({ PaddleOCR }) =>
    PaddleOCR.create({
      lang: 'ch',
      ocrVersion: 'PP-OCRv5',
      worker: true,
      // The SDK requires the model name alongside a custom asset; these are what lang ch + PP-OCRv5 select.
      textDetectionModelName: 'PP-OCRv5_mobile_det',
      textDetectionModelAsset: { url: assets.det },
      textRecognitionModelName: 'PP-OCRv5_mobile_rec',
      textRecognitionModelAsset: { url: assets.rec },
      ortOptions: {
        backend: 'wasm',
        numThreads: 2,
        simd: true,
        // onnxruntime-web accepts { wasm } here (the SDK passes it through); the SDK's typing says string.
        wasmPaths: { wasm: assets.wasm } as unknown as string,
      },
    }),
  )
}

addEventListener('message', async (event: MessageEvent<OcrRequest>) => {
  const [port] = event.ports
  const reply = (message: OcrReply) => port.postMessage(message)
  const untrusted = findUntrustedAsset(event.data.assets, self.location.origin)
  if (untrusted) return reply({ error: `Refusing OCR asset "${untrusted}" outside this site's /ocr-models/` })
  try {
    engine ??=createEngine(event.data.assets).catch(err => {
      engine = undefined // allow retry after a failed load
      throw err
    })
    const ocr = await engine
    reply({ phase: 'recognizing' })
    const [result] = await ocr.predict(event.data.image)
    reply({ lines: groupIntoLines(result.items.filter(item => item.score >= 0.5)) })
  } catch (err) {
    reply({ error: err instanceof Error ? err.message : String(err) })
  }
})
