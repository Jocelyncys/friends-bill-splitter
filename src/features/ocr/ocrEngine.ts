export type OcrPhase = 'loading' | 'recognizing'

type Engine = { predict: (image: Blob) => Promise<{ items: { text: string; score: number }[] }[]> }
let enginePromise: Promise<Engine> | undefined

/**
 * Runs PaddleOCR entirely in the browser (in a Web Worker). The SDK has no progress
 * callback, so only coarse phases are reported. The SDK is imported lazily so it stays
 * out of the main bundle. NOTE: by default the SDK downloads model files from
 * paddle-model-ecology.bj.bcebos.com and onnxruntime-web from cdn.jsdelivr.net.
 */
export async function recognizeReceipt(file: File, onProgress?: (phase: OcrPhase) => void): Promise<string[]> {
  onProgress?.('loading')
  if (!enginePromise) {
    enginePromise = import('@paddleocr/paddleocr-js')
      .then(({ PaddleOCR }) =>
        PaddleOCR.create({
          lang: 'ch',
          ocrVersion: 'PP-OCRv5',
          worker: true,
          ortOptions: { backend: 'wasm', numThreads: 2, simd: true },
        }),
      )
      .catch(err => {
        enginePromise = undefined // allow retry after a failed load
        throw err
      })
  }
  const engine = await enginePromise
  onProgress?.('recognizing')
  const [result] = await engine.predict(file)
  return result.items.filter(item => item.score >= 0.5).map(item => item.text)
}
