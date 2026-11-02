import { describe, expect, it } from 'vitest'
import { progressPercent } from './ocrProgress'

describe('progressPercent', () => {
  it('maps each stage onto one 0-100 bar', () => {
    expect(progressPercent({ stage: 'loading', loadedBytes: 0, totalBytes: 0, filesDone: 0, files: 3 })).toBe(0)
    expect(progressPercent({ stage: 'starting' })).toBe(55)
    expect(progressPercent({ stage: 'reading' })).toBe(65)
    expect(progressPercent({ stage: 'building' })).toBe(92)
  })

  it('fills the loading stage by bytes when the sizes are known', () => {
    expect(progressPercent({ stage: 'loading', loadedBytes: 50, totalBytes: 100, filesDone: 1, files: 3 })).toBe(28)
    expect(progressPercent({ stage: 'loading', loadedBytes: 100, totalBytes: 100, filesDone: 3, files: 3 })).toBe(55)
  })

  it('falls back to files done when a size is unknown or the byte count overshoots it (compressed transfer)', () => {
    expect(progressPercent({ stage: 'loading', loadedBytes: 70, totalBytes: 0, filesDone: 1, files: 3 })).toBe(18)
    expect(progressPercent({ stage: 'loading', loadedBytes: 170, totalBytes: 100, filesDone: 2, files: 3 })).toBe(37)
  })

  it('uses the per-file fraction when the download reports one', () => {
    expect(progressPercent({ stage: 'loading', loadedBytes: 70, totalBytes: 0, filesDone: 1, files: 3, fraction: 0.5 })).toBe(28)
  })
})
