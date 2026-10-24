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
const succeed: Behaviour = (_, reply) => {
  reply({ phase: 'recognizing' })
  reply({ lines: ['TEH 3.00'] })
}

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
    expect(await recognizeReceipt(file, first)).toEqual(['TEH 3.00'])
    expect(await recognizeReceipt(file, second)).toEqual(['TEH 3.00'])
    expect(workers).toHaveLength(1)
    expect(workers[0].url).toMatch(/ocr\.worker\.ts/)
    expect(first.mock.calls.map(c => c[0])).toEqual(['loading', 'recognizing'])
    expect(second.mock.calls.map(c => c[0])).toEqual(['recognizing'])
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
    expect(await recognizeReceipt(file, progress)).toEqual(['TEH 3.00'])
    expect(progress.mock.calls[0][0]).toBe('loading')
  })

  it('replaces a crashed worker', async () => {
    behaviour = (_, __, worker) => worker.dispatchEvent(Object.assign(new Event('error'), { message: 'boom' }))
    const recognizeReceipt = await load()
    await expect(recognizeReceipt(file)).rejects.toThrow('boom')
    expect(workers[0].terminated).toBe(true)
    behaviour = succeed
    expect(await recognizeReceipt(file)).toEqual(['TEH 3.00'])
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
