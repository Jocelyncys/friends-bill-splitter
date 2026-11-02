import type { OcrProgress } from './ocrProgress'

type Fetcher = (url: string) => Promise<Response>

/**
 * Downloads every file at once, reporting the bytes received so far against the summed Content-Lengths
 * (totalBytes 0 while any size is unknown). Returns the files as Blobs, in order.
 */
export async function downloadAll(
  files: Array<{ url: string; type?: string }>,
  onProgress: (progress: Extract<OcrProgress, { stage: 'loading' }>) => void,
  fetcher: Fetcher = url => fetch(url),
): Promise<Blob[]> {
  const loaded = files.map(() => 0)
  const sizes: Array<number | null | undefined> = files.map(() => undefined) // undefined: headers not in yet
  let filesDone = 0
  const done = files.map(() => false)
  const report = () => {
    const known = sizes.every(size => typeof size === 'number')
    // Each file counts the same: its bytes over its size when known, else 0 until it has finished.
    const shares = files.map((_, i) => (done[i] ? 1 : typeof sizes[i] === 'number' ? Math.min(1, loaded[i] / (sizes[i] as number)) : 0))
    onProgress({
      stage: 'loading',
      loadedBytes: loaded.reduce((sum, n) => sum + n, 0),
      totalBytes: known ? (sizes as number[]).reduce((sum, n) => sum + n, 0) : 0,
      filesDone,
      files: files.length,
      fraction: files.length > 0 ? shares.reduce((sum, n) => sum + n, 0) / files.length : 1,
    })
  }
  return Promise.all(
    files.map(async ({ url, type }, index) => {
      const response = await fetcher(url)
      if (!response.ok) throw new Error(`Download failed ${url}: HTTP ${response.status}`)
      const length = Number(response.headers.get('content-length'))
      sizes[index] = Number.isFinite(length) && length > 0 ? length : null
      const chunks: Uint8Array[] = []
      const reader = response.body?.getReader()
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          loaded[index] += value.byteLength
          report()
        }
      } else {
        const buffer = new Uint8Array(await response.arrayBuffer())
        chunks.push(buffer)
        loaded[index] = buffer.byteLength
      }
      filesDone += 1
      done[index] = true
      report()
      return new Blob(chunks as BlobPart[], type ? { type } : undefined)
    }),
  )
}
