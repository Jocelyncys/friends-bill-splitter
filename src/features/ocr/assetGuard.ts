/**
 * Returns the name of the first asset URL the OCR worker must not fetch (another origin, or outside
 * /ocr-models/), or null when all are trusted. Kept free of imports so the worker bundle stays small.
 */
export function findUntrustedAsset(assets: Record<string, string>, origin: string): string | null {
  for (const [name, value] of Object.entries(assets)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return name
    }
    if (url.origin !== origin || !url.pathname.includes('/ocr-models/')) return name
  }
  return null
}
