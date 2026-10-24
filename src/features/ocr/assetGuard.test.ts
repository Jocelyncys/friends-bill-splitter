import { describe, expect, it } from 'vitest'
import { findUntrustedAsset } from './assetGuard'

const origin = 'https://me.github.io'
const good = {
  det: 'https://me.github.io/app/ocr-models/det.tar',
  rec: 'https://me.github.io/app/ocr-models/rec.tar',
  wasm: 'https://me.github.io/app/ocr-models/ort-1.24.3/ort.wasm',
}

describe('findUntrustedAsset', () => {
  it('accepts same-origin URLs under /ocr-models/', () => {
    expect(findUntrustedAsset(good, origin)).toBeNull()
  })

  it('rejects another origin', () => {
    expect(findUntrustedAsset({ ...good, rec: 'https://cdn.example.com/app/ocr-models/rec.tar' }, origin)).toBe('rec')
  })

  it('rejects same-origin URLs outside /ocr-models/ and look-alike paths', () => {
    expect(findUntrustedAsset({ ...good, det: 'https://me.github.io/app/assets/det.tar' }, origin)).toBe('det')
    expect(findUntrustedAsset({ ...good, wasm: 'https://me.github.io/app/x?ocr-models/ort.wasm' }, origin)).toBe('wasm')
  })

  it('rejects unparsable and non-http URLs', () => {
    expect(findUntrustedAsset({ ...good, det: 'not a url' }, origin)).toBe('det')
    expect(findUntrustedAsset({ ...good, det: 'data:application/octet-stream,xx' }, origin)).toBe('det')
  })
})
