import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OcrReply, OcrRequest } from './ocrEngine'

type Behaviour = (request: OcrRequest, reply: (message: OcrReply) => void, worker: FakeWorker) => void
let behaviour: Behaviour
const workers: FakeWorker[] = []

class FakeWorker extends EventTarget {
  url: string
  terminated = false
  constructor(url: URL) {
    super()
    this.url = url.href
    workers.push(this)
  }
  postMessage(request: OcrRequest, [port]: MessagePort[]) {
    behaviour(request, message => port.postMessage(message), this)
  }
  terminate() {
    this.terminated = true
  }
}

const file = new File(['x'], 'r.jpg', { type: 'image/jpeg' })
const loadingBytes = { stage: 'loading', loadedBytes: 5, totalBytes: 10, filesDone: 1, files: 3 } as const
const succeed: Behaviour = (_, reply) => {
  reply({ progress: loadingBytes })
  reply({ progress: { stage: 'starting' } })
  reply({ progress: { stage: 'reading' } })
  reply({ lines: [{ text: 'TEH 3.00', confidence: 0.98 }] })
}
const stages = (fn: ReturnType<typeof vi.fn>) => fn.mock.calls.map(c => c[0].stage)

// Fresh module per test: the worker and readiness are cached at module level.
async function load() {
  vi.resetModules()
  return (await import('./ocrEngine')).recognizeReceipt
}

beforeEach(() => {
  workers.length = 0
  vi.stubGlobal('Worker', FakeWorker)
})
afterEach(() => vi.unstubAllGlobals())

describe('recognizeReceipt', () => {
  it('uses one worker, reports loading only until the engine is ready, and returns lines', async () => {
    behaviour = succeed
    const recognizeReceipt = await load()
    const first = vi.fn()
    const second = vi.fn()
    expect(await recognizeReceipt(file, first)).toEqual([{ text: 'TEH 3.00', confidence: 0.98 }])
    expect(await recognizeReceipt(file, second)).toEqual([{ text: 'TEH 3.00', confidence: 0.98 }])
    expect(workers).toHaveLength(1)
    expect(workers[0].url).toMatch(/ocr\.worker\.ts/)
    // Loading is reported at once (before the worker answers), then the worker's own progress.
    expect(stages(first)).toEqual(['loading', 'loading', 'starting', 'reading'])
    expect(first.mock.calls[1][0]).toEqual(loadingBytes)
    // Once the reader is ready a scan starts at reading.
    expect(stages(second)[0]).toBe('reading')
  })

  it('sends absolute, same-origin asset URLs with the image', async () => {
    let request: OcrRequest | undefined
    behaviour = (req, reply) => {
      request = req
      succeed(req, reply, workers[0])
    }
    await (await load())(file)
    expect(request?.image).toBe(file)
    const origin = new URL(document.baseURI).origin
    expect(Object.values(request!.assets).every(url => url.startsWith(`${origin}/`) && url.includes('/ocr-models/'))).toBe(true)
  })

  it('rejects with the worker error and keeps reporting loading until a retry succeeds', async () => {
    behaviour = (_, reply) => reply({ error: 'offline' })
    const recognizeReceipt = await load()
    await expect(recognizeReceipt(file)).rejects.toThrow('offline')
    behaviour = succeed
    const progress = vi.fn()
    expect(await recognizeReceipt(file, progress)).toEqual([{ text: 'TEH 3.00', confidence: 0.98 }])
    expect(progress.mock.calls[0][0].stage).toBe('loading')
  })

  it('replaces a crashed worker', async () => {
    behaviour = (_, __, worker) => worker.dispatchEvent(Object.assign(new Event('error'), { message: 'boom' }))
    const recognizeReceipt = await load()
    await expect(recognizeReceipt(file)).rejects.toThrow('boom')
    expect(workers[0].terminated).toBe(true)
    behaviour = succeed
    expect(await recognizeReceipt(file)).toEqual([{ text: 'TEH 3.00', confidence: 0.98 }])
    expect(workers).toHaveLength(2)
  })
})

describe('ocrAssetUrls', () => {
  it('resolves under a GitHub Pages sub-path', async () => {
    const { ocrAssetUrls } = await import('./ocrEngine')
    expect(ocrAssetUrls('https://me.github.io/friends-bill-splitter/#/event/1')).toEqual({
      det: 'https://me.github.io/friends-bill-splitter/ocr-models/PP-OCRv5_mobile_det_onnx_infer.tar',
      rec: 'https://me.github.io/friends-bill-splitter/ocr-models/PP-OCRv5_mobile_rec_onnx_infer.tar',
      wasm: 'https://me.github.io/friends-bill-splitter/ocr-models/ort-1.24.3/ort-wasm-simd-threaded.jsep.wasm',
    })
  })
})
