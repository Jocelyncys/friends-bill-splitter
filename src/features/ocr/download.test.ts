import { describe, expect, it, vi } from 'vitest'
import { downloadAll, sha256Hex } from './download'

function response(chunks: number[], { length = true, ok = true } = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks) controller.enqueue(new Uint8Array(size))
      controller.close()
    },
  })
  const total = chunks.reduce((sum, n) => sum + n, 0)
  return new Response(ok ? body : null, {
    status: ok ? 200 : 404,
    headers: length ? { 'content-length': String(total) } : {},
  })
}

describe('downloadAll', () => {
  it('reports bytes received over the summed sizes, then returns typed blobs in order', async () => {
    const fetcher = vi.fn(async (url: string) => (url === 'a' ? response([40, 60]) : response([100])))
    const onProgress = vi.fn()
    const blobs = await downloadAll([{ url: 'a' }, { url: 'b', type: 'application/wasm' }], onProgress, fetcher)
    expect(blobs.map(b => b.size)).toEqual([100, 100])
    expect(blobs[1].type).toBe('application/wasm')
    const last = onProgress.mock.calls.at(-1)?.[0]
    expect(last).toEqual({ stage: 'loading', loadedBytes: 200, totalBytes: 200, filesDone: 2, files: 2, fraction: 1 })
    // Never more bytes than the total while the sizes are known.
    for (const [p] of onProgress.mock.calls) expect(p.loadedBytes).toBeLessThanOrEqual(200)
  })

  it('reports an unknown total as 0 so the bar counts files instead', async () => {
    const onProgress = vi.fn()
    await downloadAll([{ url: 'a' }, { url: 'b' }], onProgress, async url => response([10], { length: url === 'a' }))
    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({ totalBytes: 0, filesDone: 2, files: 2, fraction: 1 })
    // While the file without a size is still coming, only the sized one moves the fraction.
    expect(onProgress.mock.calls.map(([p]) => p.fraction).every((f: number) => f >= 0 && f <= 1)).toBe(true)
  })

  it('fails on an HTTP error', async () => {
    await expect(downloadAll([{ url: 'a' }], () => {}, async () => response([1], { ok: false }))).rejects.toThrow('HTTP 404')
  })

  it('aborts the other downloads when one fails', async () => {
    const signals: AbortSignal[] = []
    const fetcher = vi.fn((url: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal)
      if (url === 'bad') return Promise.resolve(response([1], { ok: false }))
      return new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
    })
    await expect(downloadAll([{ url: 'slow' }, { url: 'bad' }], () => {}, fetcher)).rejects.toThrow('HTTP 404')
    expect(signals).toHaveLength(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
  })
})

describe('sha256Hex', () => {
  it('hashes the bytes of a blob', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
