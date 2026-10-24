import { beforeEach, describe, expect, it, vi } from 'vitest'

const create = vi.fn()
vi.mock('@paddleocr/paddleocr-js', () => ({ PaddleOCR: { create: (...a: unknown[]) => create(...a) } }))

const file = new File(['x'], 'r.jpg', { type: 'image/jpeg' })
const engine = () => ({ predict: vi.fn().mockResolvedValue([{ items: [{ text: 'TEH 3.00', score: 0.9 }, { text: 'noise', score: 0.2 }] }]) })

// Fresh module per test: the engine promise is cached at module level.
async function load() {
  vi.resetModules()
  return (await import('./ocrEngine')).recognizeReceipt
}

beforeEach(() => create.mockReset())

describe('recognizeReceipt', () => {
  it('creates the engine once, reports loading only the first time, and filters low scores', async () => {
    create.mockResolvedValue(engine())
    const recognizeReceipt = await load()
    const first = vi.fn()
    const second = vi.fn()
    expect(await recognizeReceipt(file, first)).toEqual(['TEH 3.00'])
    await recognizeReceipt(file, second)
    expect(create).toHaveBeenCalledTimes(1)
    expect(first.mock.calls.map(c => c[0])).toEqual(['loading', 'recognizing'])
    expect(second.mock.calls.map(c => c[0])).toEqual(['recognizing'])
  })

  it('clears a rejected create so the next call retries', async () => {
    create.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(engine())
    const recognizeReceipt = await load()
    await expect(recognizeReceipt(file)).rejects.toThrow('offline')
    expect(await recognizeReceipt(file)).toEqual(['TEH 3.00'])
    expect(create).toHaveBeenCalledTimes(2)
  })
})
